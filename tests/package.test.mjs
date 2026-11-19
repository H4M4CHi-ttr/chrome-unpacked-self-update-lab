import assert from "node:assert/strict";
import { test } from "node:test";
import { REPOSITORY } from "../extension/config.js";
import { sha256 } from "../extension/core.js";
import { PACKAGE_FORMAT, assertCompatibleManifest, hashFiles, packageInventory, replacePackage, restorePackage } from "../extension/package.js";
import { unpackPackage, verifyPackageManifest } from "../extension/release.js";
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

async function signedPackage(files, { extra = {}, metadata = {} } = {}) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const archive = Object.fromEntries(Object.entries(files).map(([path, bytes]) => ["extension/" + path, bytes]));
  const zip = zipSync({ ...archive, ...extra });
  const raw = json({ format: PACKAGE_FORMAT, repository: REPOSITORY, version: newVersion, tag: "v" + newVersion,
    zip: { bytes: zip.length, sha256: await sha256(zip) }, files: await hashFiles(files), ...metadata });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, raw));
  const verify = () => verifyPackageManifest(raw, signature, publicKey, newVersion, "v" + newVersion);
  return { zip, verify, signature };
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
