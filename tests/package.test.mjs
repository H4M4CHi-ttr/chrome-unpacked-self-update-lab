import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPOSITORY } from "../extension/config.js";
import { sha256 } from "../extension/core.js";
import { PACKAGE_FORMAT, assertCompatibleManifest, hashFiles, packageInventory, replacePackage, restorePackage } from "../extension/package.js";
import { downloadPackage, latestRelease, unpackPackage, verifyPackageManifest } from "../extension/release.js";
import { zipSync } from "../extension/vendor/fflate.js";

const encode = (str) => new TextEncoder().encode(str);
const json = (value) => encode(JSON.stringify(value));
const manifest = (version) => ({ manifest_version: 3, version, name: "Demo", permissions: ["alarms"] });
const oldVersion = "1.1.0";
const newVersion = "1.2.0";

async function fixtureFiles(version, extras = {}) {
  const files = {
    "manifest.json": json(manifest(version)),
    "poc-identity.json": json({ id: "fixture" }),
    "trust.json": json({ crv: "P-256" }),
    "active.js": encode("export const version = " + JSON.stringify(version)),
    ...extras,
  };
  const hashes = await hashFiles(files);
  return { ...files, "install.json": json({ format: PACKAGE_FORMAT, version, sha256: hashes["active.js"], files: hashes }) };
}

async function signedPackage(files, { extra = {}, metadata = {}, keyPair } = {}) {
  const pair = keyPair ?? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const archive = Object.fromEntries(Object.entries(files).map(([path, bytes]) => ["extension/" + path, bytes]));
  const zip = zipSync({ ...archive, ...extra });
  const raw = json({ format: PACKAGE_FORMAT, repository: REPOSITORY, version: newVersion, tag: "v" + newVersion,
    zip: { bytes: zip.length, sha256: await sha256(zip) }, files: await hashFiles(files), ...metadata });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, raw));
  const verify = () => verifyPackageManifest(raw, signature, publicKey, newVersion, "v" + newVersion);
  return { zip, verify, signature, raw, publicKey };
}

test("the signed install ZIP binds the manifest and every package file", async () => {
  const files = await fixtureFiles(newVersion, { "popup.html": encode("new markup") });
  const signed = await signedPackage(files);
  const info = await signed.verify();
  const result = await unpackPackage(signed.zip, info);
  assert.equal(result.version, newVersion);
  assert.deepEqual(result.files, files);
  const tampered = signed.zip.slice();
  tampered[0] ^= 1;
  await assert.rejects(unpackPackage(tampered, info), { name: "IntegrityError" });
  signed.signature[0] ^= 1;
  await assert.rejects(signed.verify(), { name: "SignatureError" });
});

test("downloads a verified release without credentials for public repos and by API asset ID for private repos", async (t) => {
  const files = await fixtureFiles(newVersion);
  const { raw, signature, zip, publicKey } = await signedPackage(files);
  const tag = "v" + newVersion;
  const api = `https://api.github.com/repos/${REPOSITORY}/releases`;
  const names = ["package-update.json", "package-update.sig", "auto-update-https.zip"];
  const payloads = [raw, signature, zip];
  for (const token of [undefined, "fixture-token"]) {
    await t.test(token ? "private" : "public", async (t) => {
      const assets = names.map((name, index) => ({
        name, id: index + 1,
        browser_download_url: token ? "https://untrusted.example/" + name
          : `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`,
      }));
      const expected = [
        [api + "/latest", "application/vnd.github+json", json({ tag_name: tag, assets })],
        ...assets.map((asset, index) => [
          token ? api + "/assets/" + asset.id : asset.browser_download_url,
          token ? "application/octet-stream" : null,
          payloads[index],
        ]),
      ];
      const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
        const [target, accept, body] = expected.shift();
        const headers = new Headers(options.headers);
        assert.equal(url, target);
        assert.equal(headers.get("accept"), accept);
        assert.equal(headers.get("authorization"), token ? "Bearer " + token : null);
        assert.equal(options.credentials, "omit");
        return new Response(body);
      });
      const release = await latestRelease(token);
      const pending = await downloadPackage(release, publicKey, token);
      assert.deepEqual(pending.files, files);
      assert.equal(expected.length, 0);
      if (token) {
        release.assets[0].id = "1/../../untrusted";
        await assert.rejects(downloadPackage(release, publicKey, token), { name: "ReleaseError" });
        assert.equal(fetch.mock.callCount(), 4);
      }
    });
  }
});

test("rejects unlisted ZIP entries even when the archive is signed", async () => {
  const files = await fixtureFiles(newVersion);
  const signed = await signedPackage(files, { extra: { "extension/../../outside": encode("unsafe") } });
  await assert.rejects(unpackPackage(signed.zip, await signed.verify()), { name: "ReleaseError" });
});

test("rejects Windows aliases, case collisions and a mismatched manifest version", async () => {
  for (const extras of [
    { "AUX.js": encode("reserved") },
    { "Folder/name.js": encode("one"), "folder/other.js": encode("two") },
    { "foo": encode("file"), "foo/bar.js": encode("nested") },
    { "foo\\bar.js": encode("separator") },
  ]) {
    const signed = await signedPackage(await fixtureFiles(newVersion, extras));
    await assert.rejects(signed.verify(), { name: "PackageError" });
  }
  const mismatched = await signedPackage(await fixtureFiles(newVersion, { "manifest.json": json(manifest(oldVersion)) }));
  await assert.rejects(unpackPackage(mismatched.zip, await mismatched.verify()), { name: "PackageError" });
});

test("the Chromium display version must match the signed release version", async () => {
  const filesWithDisplayVersion = (version_name) =>
    fixtureFiles(newVersion, { "manifest.json": json({ ...manifest(newVersion), version_name }) });
  const stale = await signedPackage(await filesWithDisplayVersion(oldVersion));
  await assert.rejects(unpackPackage(stale.zip, await stale.verify()), { name: "PackageError" });
  const matching = await signedPackage(await filesWithDisplayVersion(newVersion));
  assert.equal((await unpackPackage(matching.zip, await matching.verify())).version, newVersion);
});

test("permits the manifest version and display name to change, but requires manual installation for permissions or identity changes", () => {
  assert.doesNotThrow(() => assertCompatibleManifest(manifest(oldVersion), json({ ...manifest(newVersion), name: "New name" }), newVersion));
  for (const changed of [
    { permissions: ["alarms", "tabs"] },
    { content_scripts: [{ matches: ["<all_urls>"], js: ["script.js"] }] },
    { key: "different" },
    { externally_connectable: { matches: ["https://example.com/*"] } },
  ]) assert.throws(() => assertCompatibleManifest(manifest(oldVersion), json({ ...manifest(newVersion), ...changed }), newVersion), { name: "PackageError" });
});

function fakeDirectory(initial) {
  const files = new Map(Object.entries(initial));
  const directories = new Set([""]);
  for (const name of files.keys()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/") + "/");
  }
  const events = [], fail = new Set();
  const missing = () => new DOMException("missing", "NotFoundError");
  const folder = (prefix) => ({
    async queryPermission() { return "granted"; },
    async getDirectoryHandle(name, { create = false } = {}) {
      const path = prefix + name + "/";
      if (files.has(prefix + name)) throw new DOMException("file exists", "TypeMismatchError");
      if (!directories.has(path) && !create) throw missing();
      directories.add(path);
      return folder(path);
    },
    async getFileHandle(name, { create = false } = {}) {
      const path = prefix + name;
      if (directories.has(path + "/")) throw new DOMException("directory exists", "TypeMismatchError");
      if (!files.has(path)) {
        if (!create) throw missing();
        files.set(path, new Uint8Array());
      }
      return {
        kind: "file", name, path,
        async isSameEntry(other) { return other.path === path; },
        async getFile() {
          if (!files.has(path)) throw missing();
          return new Blob([files.get(path)]);
        },
        async createWritable() {
          let bytes;
          return {
            async write(value) { bytes = value; },
            async close() {
              if (fail.has(path)) throw new DOMException("close failed", "NotAllowedError");
              events.push(path);
              files.set(path, bytes);
            },
            async abort() {},
          };
        },
      };
    },
    async removeEntry(name) { events.push("-" + prefix + name); files.delete(prefix + name); },
  });
  return { directory: folder(""), files, events, fail };
}


test("the internal worker holds a signed update, protects an identical copy and confirms it only on the next boot", async (t) => {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const trust = json(await crypto.subtle.exportKey("jwk", keyPair.publicKey));
  const before = await fixtureFiles(oldVersion, { "trust.json": trust });
  const after = await fixtureFiles(newVersion, { "trust.json": trust });
  const { raw, signature, zip } = await signedPackage(after, { keyPair });
  const assets = new Map([["package-update.json", raw], ["package-update.sig", signature], ["auto-update-https.zip", zip]]);
  const disk = fakeDirectory(before), copy = fakeDirectory(before);
  let permission = "prompt", reloads = 0, receiver, alarm;
  disk.directory.queryPermission = async () => permission;
  const state = new Map([["directory", disk.directory], ["enabled", true]]);
  const events = [];
  const store = {
    load: async (key) => state.get(key),
    save: async (key, value) => state.set(key, value),
    saveAll: async (values) => { for (const [key, value] of Object.entries(values)) state.set(key, value); },
    record: async (event) => events.push(event),
    readEvents: async () => events,
  };
  const extensionId = "a".repeat(32);
  const ownURL = (name) => "chrome-extension://" + extensionId + "/" + name;
  const sender = { id: extensionId, url: ownURL("popup.html") };
  const chromeAPI = {
    runtime: {
      id: extensionId, getURL: ownURL, getManifest: () => JSON.parse(new TextDecoder().decode(disk.files.get("manifest.json"))),
      reload: () => { reloads++; }, onMessage: { addListener: (fn) => { receiver = fn; } },
      onStartup: { addListener() {} },
    },
    action: { async setBadgeText() {} },
    alarms: {
      get: async () => alarm, create: async (_, info) => { alarm = info; }, clear: async () => { alarm = null; },
      onAlarm: { addListener() {} },
    },
  };

  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "extension-worker-test-"));
  let tail = Promise.resolve();
  const locks = { request: (_, task) => { const result = tail.then(task); tail = result.catch(() => {}); return result; } };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  globalThis.chrome = chromeAPI;
  globalThis.internalWorkerTestStore = store;
  t.after(async () => {
    delete navigator.locks;
    delete globalThis.chrome;
    delete globalThis.internalWorkerTestStore;
    assert.equal(dirname(await realpath(root)), parent);
    await rm(root, { recursive: true });
  });

  const tag = "v" + newVersion;
  const downloadURL = "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.protocol === "chrome-extension:" && url.hostname === extensionId) return new Response(disk.files.get(url.pathname.slice(1)));
    if (url.href === "https://api.github.com/repos/" + REPOSITORY + "/releases/latest") {
      return Response.json({ tag_name: tag, assets: [...assets.keys()].map((name, i) => ({ name, id: i + 1, browser_download_url: downloadURL + name })) });
    }
    assert.ok(url.href.startsWith(downloadURL));
    return new Response(assets.get(url.href.slice(downloadURL.length)));
  });

  async function boot(number) {
    const dir = join(root, "boot-" + number);
    await cp(new URL("../extension/", import.meta.url), dir, { recursive: true });
    await writeFile(join(dir, "store.js"), "export const { load, save, saveAll, record, readEvents } = globalThis.internalWorkerTestStore;\n");
    await writeFile(join(dir, "active.js"), disk.files.get("active.js"));
    await import(pathToFileURL(join(dir, "worker.js")));
  }
  const command = (kind) => new Promise((resolve) => { assert.equal(receiver({ kind }, sender, resolve), true); });

  await boot(1);
  const initial = await command("status");
  assert.equal(receiver({ kind: "apply" }, { id: extensionId, url: "https://example.org/" }, assert.fail), undefined);
  await command("check");
  assert.equal((await command("status")).status.phase, "permission-required");
  assert.equal(state.get("pending").version, newVersion);
  assert.deepEqual(disk.events, []);

  state.set("directory", copy.directory);
  await command("apply");
  assert.equal((await command("status")).status.phase, "folder-required");
  assert.deepEqual(Object.fromEntries(copy.files), before);
  assert.deepEqual(copy.events, ["install.json", "install.json"]);
  assert.equal(reloads, 0);

  state.set("directory", disk.directory);
  state.set("blocked", null);
  permission = "granted";
  await command("folder-ready");
  assert.equal(reloads, 1);
  assert.equal(state.get("receipt").status, "written");
  assert.ok(state.get("recovery"));
  assert.deepEqual(Object.fromEntries(disk.files), after);
  await boot(2);
  const updated = await command("status");
  assert.notEqual(updated.bootId, initial.bootId);
  assert.equal(updated.version, newVersion);
  assert.equal(updated.manifestVersion, newVersion);
  assert.equal(updated.receipt.status, "executed");
  assert.equal(state.get("recovery"), null);
});

async function transaction() {
  const old = await fixtureFiles(oldVersion, { "popup.html": encode("old"), "retired.js": encode("obsolete") });
  const next = await fixtureFiles(newVersion, { "popup.html": encode("new"), "assets/new.css": encode("new file") });
  const bundle = await packageInventory(old["install.json"]);
  const target = await packageInventory(next["install.json"]);
  const model = fakeDirectory({ ...old, "local-file.txt": encode("keep me") });
  let backup;
  const apply = (marker = async () => sha256(model.files.get("install.json"))) => replacePackage(model.directory, bundle, next, {
    targetHash: target.sha256,
    onBackup: async (value) => { assert.deepEqual(model.events, []); backup = value; },
    readMarker: marker,
  });
  return { old, next, model, apply, recovery: () => backup };
}

test("backs up the package, proves the folder, adds and removes managed files, and writes the manifest last", async () => {
  const tx = await transaction();
  await tx.apply();
  assert.equal(tx.model.events[0], "install.json");
  assert.equal(tx.model.events.at(-1), "manifest.json");
  assert.equal(tx.model.files.has("retired.js"), false);
  assert.deepEqual(tx.model.files.get("assets/new.css"), tx.next["assets/new.css"]);
  assert.deepEqual(tx.model.files.get("local-file.txt"), encode("keep me"));
  assert.deepEqual(tx.model.files.get("manifest.json"), tx.next["manifest.json"]);
  await restorePackage(tx.recovery());
  assert.deepEqual(Object.fromEntries(tx.model.files), { ...tx.old, "local-file.txt": encode("keep me") });
});

test("a different copy only receives the marker and can be restored without replacing the manifest", async () => {
  const tx = await transaction();
  await assert.rejects(tx.apply(() => sha256(tx.old["install.json"])), { name: "FolderValidationError" });
  assert.deepEqual(tx.model.events, ["install.json"]);
  await restorePackage(tx.recovery());
  assert.deepEqual(Object.fromEntries(tx.model.files), { ...tx.old, "local-file.txt": encode("keep me") });
});

test("a failed write to a newly created file leaves the old package recoverable", async () => {
  const tx = await transaction();
  tx.model.fail.add("assets/new.css");
  await assert.rejects(tx.apply(), { name: "NotAllowedError" });
  assert.ok(!tx.model.events.includes("manifest.json"));
  await restorePackage(tx.recovery());
  assert.deepEqual(Object.fromEntries(tx.model.files), { ...tx.old, "local-file.txt": encode("keep me") });
});

test("refuses an edited file before writing, and preserves an external edit when recovery is requested", async () => {
  const tx = await transaction();
  tx.model.files.set("popup.html", encode("before, user edit"));
  await assert.rejects(tx.apply(), { name: "SourceMismatchError" });
  assert.deepEqual(tx.model.events, []);
  tx.model.files.set("popup.html", tx.old["popup.html"]);
  await tx.apply();
  tx.model.files.set("popup.html", encode("after, user edit"));
  await assert.rejects(restorePackage(tx.recovery()), { name: "SourceMismatchError" });
  assert.deepEqual(tx.model.files.get("popup.html"), encode("after, user edit"));
});
