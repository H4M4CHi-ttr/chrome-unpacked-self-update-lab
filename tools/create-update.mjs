import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_CODE_BYTES, MAX_ZIP_BYTES, REPOSITORY } from "../extension/config.js";
import { sha256 } from "../extension/core.js";
import { compareVersions, unpackVerified, verifyManifest } from "../extension/release.js";
import { zipSync } from "../extension/vendor/fflate.js";

const [version, sourcePath, keyPath, destination] = process.argv.slice(2);
if (!destination) throw new Error("Usage: node tools/create-update.mjs <x.y.z> <active.js> <P-256-private.pem> <new-output-dir>");
compareVersions(version, version);
const tag = "v" + version;
const code = await readFile(sourcePath);
if (!code.length || code.length > MAX_CODE_BYTES) throw new Error("active.js exceeds the package size limit or is empty");
const source = new TextDecoder("utf-8", { fatal: true }).decode(code);
if (!source.split(/\r?\n/).includes("export const version = " + JSON.stringify(version) + ";")) {
  throw new Error('Declare the same code version on its own line: export const version = "' + version + '";');
}
const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: code, encoding: "utf8" });
if (syntax.status !== 0) throw new Error(syntax.error?.message ?? syntax.stderr ?? "Syntax check failed");

const privateKey = createPrivateKey(await readFile(keyPath));
const publicKey = createPublicKey(privateKey).export({ format: "jwk" });
if (publicKey.kty !== "EC" || publicKey.crv !== "P-256") throw new Error("Signing requires a P-256 private key");
const zip = zipSync({ "active.js": code }, { level: 6 });
if (zip.length > MAX_ZIP_BYTES) throw new Error("ZIP exceeds the package size limit");
const info = { format: 1, repository: REPOSITORY, version, tag,
  file: { path: "active.js", bytes: code.length, sha256: await sha256(code) },
  zip: { bytes: zip.length, sha256: await sha256(zip) } };
const raw = Buffer.from(JSON.stringify(info, null, 2) + "\n");
const signature = sign("sha256", raw, { key: privateKey, dsaEncoding: "ieee-p1363" });
await unpackVerified(zip, await verifyManifest(raw, signature, publicKey, version, tag));

const dir = resolve(destination);
await mkdir(dir);
for (const [name, content] of Object.entries({
  "update.json": raw, "update.sig": signature, "update.zip": zip,
  "trust.json": JSON.stringify(publicKey, null, 2) + "\n",
  "install.json": JSON.stringify({ version, sha256: info.file.sha256 }, null, 2) + "\n",
})) await writeFile(resolve(dir, name), content, { flag: "wx" });
console.log(tag + " verified. Release assets: update.json, update.sig, update.zip. For a new bootstrap: trust.json, install.json.");
