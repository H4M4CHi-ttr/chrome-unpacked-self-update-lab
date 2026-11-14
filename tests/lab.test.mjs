import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "../extension/vendor/fflate.js";
import { compareVersions, fetchLimited, unpackVerified, verifyManifest } from "../extension/release.js";
import { IMMUTABLE_FILES, equalBytes, replaceActive, restoreRecovery, sha256 } from "../extension/core.js";
import { PROTOCOL, UPDATER_URL, isAllowedWebSender, isUpdaterTab, isValidMessage, updaterURL } from "../extension/bridge.js";
import { MAX_CODE_BYTES, REPOSITORY } from "../extension/config.js";

const bytes = (value) => new TextEncoder().encode(value);
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
const code = bytes('export const version = "0.1.1";\n');

async function signed(overrides = {}, zipFiles = { "active.js": code }) {
  const zip = zipSync(zipFiles);
  const info = { format: 1, repository: REPOSITORY, version: "0.1.1", tag: "v0.1.1", file: { path: "active.js", bytes: code.length, sha256: await sha256(code) }, zip: { bytes: zip.length, sha256: await sha256(zip) }, ...overrides };
  const raw = bytes(JSON.stringify(info));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, raw));
  return { zip, info, raw, signature };
}

test("a signed manifest and ZIP yield the exact active.js bytes", async () => {
  const fixture = await signed();
  const info = await verifyManifest(fixture.raw, fixture.signature, publicKey, "0.1.1", "v0.1.1");
  assert.ok(equalBytes(await unpackVerified(fixture.zip, info), code));
});

test("rejects changed manifest bytes before using paths or sizes", async () => {
  const fixture = await signed(); fixture.raw[0] ^= 1;
  await assert.rejects(verifyManifest(fixture.raw, fixture.signature, publicKey, "0.1.1", "v0.1.1"), { name: "SignatureError" });
});

test("rejects signatures from another key", async () => {
  const fixture = await signed();
  const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const otherKey = await crypto.subtle.exportKey("jwk", other.publicKey);
  await assert.rejects(verifyManifest(fixture.raw, fixture.signature, otherKey, "0.1.1", "v0.1.1"), { name: "SignatureError" });
});

test("rejects a malformed signature", async () => {
  const fixture = await signed();
  await assert.rejects(verifyManifest(fixture.raw, new Uint8Array(5), publicKey, "0.1.1", "v0.1.1"), { name: "SignatureError" });
});

for (const [name, overrides] of [
  ["another repository", { repository: "elsewhere/repo" }],
  ["wrong version", { version: "0.1.2" }],
  ["wrong tag", { tag: "v0.1.2" }],
  ["path traversal", { file: { path: "../active.js", bytes: code.length, sha256: await sha256(code) } }],
  ["oversized code", { file: { path: "active.js", bytes: MAX_CODE_BYTES + 1, sha256: await sha256(code) } }],
]) {
  test(`rejects a valid signature carrying ${name}`, async () => {
    const fixture = await signed(overrides);
    await assert.rejects(verifyManifest(fixture.raw, fixture.signature, publicKey, "0.1.1", "v0.1.1"), { name: "ReleaseError" });
  });
}

test("rejects ZIP bytes that differ from the signed digest", async () => {
  const fixture = await signed(); fixture.zip[0] ^= 1;
  await assert.rejects(unpackVerified(fixture.zip, fixture.info), { name: "IntegrityError" });
});

test("rejects files beyond active.js even inside a correctly signed ZIP", async () => {
  const fixture = await signed({}, { "active.js": code, "manifest.json": bytes("{}") });
  await assert.rejects(unpackVerified(fixture.zip, fixture.info), { name: "ReleaseError" });
});

test("rejects an unzipped payload with the wrong code digest", async () => {
  const fixture = await signed(); fixture.info.file.sha256 = "0".repeat(64);
  await assert.rejects(unpackVerified(fixture.zip, fixture.info), { name: "IntegrityError" });
});

test("version comparison is numeric and rejects non-normal releases", () => {
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  for (const value of ["01.1.0", "v1.2.3", "1.2.3-beta", "1.2", "9007199254740992.0.0"]) assert.throws(() => compareVersions(value, "0.1.0"), { name: "ReleaseError" });
});

class MemoryFile {
  constructor(value) { this.value = value.slice(); this.opens = 0; this.failClose = new Set(); this.afterClose = new Map(); }
  async getFile() { const value = this.value.slice(); return { arrayBuffer: async () => value.buffer }; }
  async createWritable(options) {
    assert.deepEqual(options, { keepExistingData: false });
    const turn = ++this.opens;
    let pending;
    return { write: async (value) => { pending = value.slice(); }, close: async () => { if (this.failClose.has(turn)) throw new DOMException("denied", "NotAllowedError"); this.value = this.afterClose.get(turn) ?? pending; }, abort: async () => {} };
  }
}

async function folderFixture() {
  const before = bytes("old source");
  const files = Object.fromEntries(IMMUTABLE_FILES.map((name) => [name, bytes(name)]));
  const entries = new Map(Object.entries({ ...files, "active.js": before }).map(([name, value]) => [name, new MemoryFile(value)]));
  const directory = {
    permission: "granted", async queryPermission() { return this.permission; },
    async getFileHandle(name, options) { assert.equal(options, undefined); if (!entries.has(name)) throw new DOMException("missing", "NotFoundError"); return entries.get(name); },
    async getDirectoryHandle(name) { return { getFileHandle: (file, options) => this.getFileHandle(`${name}/${file}`, options) }; },
  };
  const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, value]) => [key, await sha256(value)])));
  return { directory, entries, active: entries.get("active.js"), bundle: { files: hashes, sha256: await sha256(before) }, before };
}

test("updates only active.js and waits for durable backup before writing", async () => {
  const fixture = await folderFixture();
  let backedUp = false;
  await replaceActive(fixture.directory, fixture.bundle, code, {
    onBackup: async (backup) => { assert.equal(fixture.active.opens, 0); assert.ok(equalBytes(backup.before, fixture.before)); backedUp = true; },
    readPackaged: async () => { assert.ok(backedUp); return sha256(code); },
  });
  assert.ok(equalBytes(fixture.active.value, code));
  for (const [name, file] of fixture.entries) if (name !== "active.js") assert.equal(file.opens, 0, name);
});

test("rejects a same-content copy when Chrome's own URL does not reflect the write", async () => {
  const fixture = await folderFixture();
  await assert.rejects(replaceActive(fixture.directory, fixture.bundle, code, {
    onBackup: async () => {}, readPackaged: async () => fixture.bundle.sha256,
  }), (error) => error.name === "FolderValidationError" && error.rollback === "restored");
  assert.ok(equalBytes(fixture.active.value, fixture.before));
});

test("rejects an incorrect identity without writing", async () => {
  const fixture = await folderFixture(); fixture.entries.get("poc-identity.json").value = bytes("different");
  await assert.rejects(replaceActive(fixture.directory, fixture.bundle, code, {}), { name: "FolderValidationError" });
  assert.equal(fixture.active.opens, 0);
});

test("rejects permissions that need user action before touching files", async () => {
  const fixture = await folderFixture(); fixture.directory.permission = "prompt";
  await assert.rejects(replaceActive(fixture.directory, fixture.bundle, code, {}), { name: "NotAllowedError" });
  assert.equal(fixture.active.opens, 0);
});

test("preserves a user edit instead of overwriting it", async () => {
  const fixture = await folderFixture(); fixture.active.value = bytes("user edit");
  await assert.rejects(replaceActive(fixture.directory, fixture.bundle, code, {}), { name: "SourceMismatchError" });
  assert.equal(fixture.active.opens, 0);
});

test("restores original source on a close failure", async () => {
  const fixture = await folderFixture(); fixture.active.failClose.add(1);
  await assert.rejects(replaceActive(fixture.directory, fixture.bundle, code, { onBackup: async () => {} }), (error) => error.rollback === "restored");
  assert.ok(equalBytes(fixture.active.value, fixture.before));
  assert.equal(fixture.active.opens, 1);
});

test("reports a failed rollback while the durable backup remains available", async () => {
  const fixture = await folderFixture(); fixture.active.failClose.add(2);
  let backup;
  await assert.rejects(replaceActive(fixture.directory, fixture.bundle, code, {
    onBackup: async (value) => { backup = value; }, readPackaged: async () => fixture.bundle.sha256,
  }), (error) => error.rollback === "failed" && error.rollbackError.name === "NotAllowedError");
  assert.ok(equalBytes(backup.before, fixture.before));
  await restoreRecovery(backup);
  assert.ok(equalBytes(fixture.active.value, fixture.before));
});

test("does not write when the durable backup or begin request fails", async () => {
  const fixture = await folderFixture();
  await assert.rejects(replaceActive(fixture.directory, fixture.bundle, code, {
    onBackup: async () => { throw new Error("storage failed"); },
  }), /storage failed/);
  assert.equal(fixture.active.opens, 0);
});

test("the rollback does not overwrite a separate edit made after the write began", async () => {
  const fixture = await folderFixture();
  const other = bytes("another editor");
  fixture.active.afterClose.set(1, other);
  await assert.rejects(replaceActive(fixture.directory, fixture.bundle, code, {
    onBackup: async () => {},
  }), (error) => error.rollback === "failed" && error.rollbackError.name === "SourceMismatchError");
  assert.ok(equalBytes(fixture.active.value, other));
});

test("accepts only the registered updater origin, path, top frame and target tab", () => {
  const id = "a".repeat(32);
  const url = updaterURL(id);
  const sender = { url, origin: new URL(url).origin, frameId: 0 };
  assert.ok(isAllowedWebSender(sender) && isUpdaterTab({ url }, id));
  assert.ok(!isAllowedWebSender({ ...sender, frameId: 1 }));
  assert.ok(!isAllowedWebSender({ ...sender, url: UPDATER_URL + "other" }));
  assert.ok(!isAllowedWebSender({ ...sender, origin: "null" }));
  assert.ok(!isAllowedWebSender({ ...sender, url: url.replace("github.io", "github.io.evil.example") }));
  assert.ok(!isUpdaterTab({ url }, "b".repeat(32)));
});

test("begin and commit require validated transaction identifiers and digests", () => {
  const token = crypto.randomUUID(), hash = "0".repeat(64);
  const message = { protocol: PROTOCOL, action: "begin", token, beforeHash: hash, targetHash: hash };
  assert.ok(isValidMessage(message));
  assert.ok(!isValidMessage({ ...message, beforeHash: undefined }));
  assert.ok(!isValidMessage({ ...message, token: "-".repeat(36) }));
  assert.ok(!isValidMessage({ ...message, action: "permission", permission: "allowed" }));
  assert.ok(isValidMessage({ protocol: PROTOCOL, action: "commit", token }));
  assert.ok(!isValidMessage({ protocol: PROTOCOL, action: "commit" }));
});

test("limits streamed downloads and records rate-limit retry time", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(new Uint8Array(10));
    await assert.rejects(fetchLimited("https://github.com/test", 5), { name: "ReleaseError" });
    globalThis.fetch = async () => new Response("", { status: 429 });
    await assert.rejects(fetchLimited("https://github.com/test", 5), (error) => error.name === "NetworkError" && error.retryAt > Date.now());
  } finally { globalThis.fetch = originalFetch; }
});
