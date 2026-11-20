import { sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createUpdate } from "./create-update.mjs";
import { REPOSITORY } from "../extension/config.js";
import { sha256 } from "../extension/core.js";
import {
  PACKAGE_FORMAT, PACKAGE_INDEX, PACKAGE_METADATA, PACKAGE_SIGNATURE, PACKAGE_ZIP,
  decodeJSON, hashFiles, validatePackageVersion,
} from "../extension/package.js";
import { compareVersions, unpackPackage, verifyPackageManifest } from "../extension/release.js";
import { zipSync } from "../extension/vendor/fflate.js";

const extension = new URL("../extension/", import.meta.url);
const packagePaths = [
  "manifest.json", "poc-identity.json", "popup.html", "popup.css", "popup.js", "worker.js",
  "core.js", "store.js", "release.js", "config.js", "trust.json", "vendor/fflate.js",
  "vendor/LICENSE.fflate", "active.js", "package.js",
];
const readFiles = async () => Object.fromEntries(await Promise.all(packagePaths.map(async (name) =>
  [name, await readFile(new URL(name, extension))])));
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

async function installIndex(version, files) {
  const hashes = await hashFiles(files);
  return json({ format: PACKAGE_FORMAT, version, sha256: hashes["active.js"], files: hashes });
}

if (process.argv[2] === "--next") {
  const match = /^v1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(process.argv[3] ?? "");
  if (!match) throw new Error("The latest release must be on the v1.x demo series");
  const minor = Number(match[1]) + 1;
  if (minor > 65535) throw new Error("The next minor version would exceed Chrome's manifest limit");
  console.log("v1." + minor + ".0");
} else if (["--refresh-index", "--check-index"].includes(process.argv[2])) {
  const files = await readFiles();
  const { version } = decodeJSON(files["manifest.json"]);
  validatePackageVersion(version);
  const path = new URL(PACKAGE_INDEX, extension);
  const expected = await installIndex(version, files);
  if (process.argv[2] === "--refresh-index") await writeFile(path, expected);
  else if (!(await readFile(path)).equals(expected)) throw new Error("Regenerate extension/install.json with --refresh-index");
} else {
  const [version, destination] = process.argv.slice(2);
  const privatePEM = process.env.DEMO_SIGNING_KEY_PEM;
  delete process.env.DEMO_SIGNING_KEY_PEM;
  if (!destination || !privatePEM) {
    throw new Error("Set DEMO_SIGNING_KEY_PEM and run node tools/build-release.mjs <x.y.z> <new-output-dir>");
  }
  const files = await readFiles();
  const manifest = decodeJSON(files["manifest.json"]);
  const baseline = manifest.version;
  validatePackageVersion(version);
  if (compareVersions(version, baseline) < 0) throw new Error("Release precedes the checked-out extension");
  const source = files["active.js"].toString("utf8");
  const declaration = 'export const version = "' + baseline + '";';
  if (source.split(/\r?\n/).filter((line) => line === declaration).length !== 1) {
    throw new Error("Expected one active.js version declaration matching the bootstrap manifest");
  }
  const code = Buffer.from(source.replace(declaration, 'export const version = "' + version + '";'));
  const trust = decodeJSON(files["trust.json"]);
  const assets = await createUpdate(version, code, privatePEM, trust);
  manifest.version = version;
  if (Object.hasOwn(manifest, "version_name")) manifest.version_name = version;
  files["manifest.json"] = json(manifest);
  files["active.js"] = code;
  files[PACKAGE_INDEX] = await installIndex(version, files);
  const installZip = zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => ["extension/" + name, bytes])), { level: 6 });
  const tag = "v" + version;
  const raw = json({
    format: PACKAGE_FORMAT, repository: REPOSITORY, version, tag, files: await hashFiles(files),
    zip: { sha256: await sha256(installZip), bytes: installZip.length },
  });
  const signature = sign("sha256", raw, { key: privatePEM, dsaEncoding: "ieee-p1363" });
  await unpackPackage(installZip, await verifyPackageManifest(raw, signature, trust, version, tag));
  const dir = resolve(destination);
  await mkdir(dir);
  for (const name of ["update.json", "update.sig", "update.zip"]) {
    await writeFile(resolve(dir, name), assets[name], { flag: "wx" });
  }
  await writeFile(resolve(dir, PACKAGE_ZIP), installZip, { flag: "wx" });
  await writeFile(resolve(dir, PACKAGE_METADATA), raw, { flag: "wx" });
  await writeFile(resolve(dir, PACKAGE_SIGNATURE), signature, { flag: "wx" });
  console.log(tag + ": package ZIP and legacy active.js update verified against extension/trust.json");
}
