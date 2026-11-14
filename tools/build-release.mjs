import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createUpdate } from "./create-update.mjs";
import { IMMUTABLE_FILES } from "../extension/core.js";
import { compareVersions } from "../extension/release.js";
import { zipSync } from "../extension/vendor/fflate.js";

const extension = new URL("../extension/", import.meta.url);

if (process.argv[2] === "--next") {
  const match = /^v1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(process.argv[3] ?? "");
  if (!match) throw new Error("The latest release must be on the v1.x demo series");
  const minor = Number(match[1]) + 1;
  if (minor > 65535) throw new Error("The next minor version would exceed Chrome's manifest limit");
  console.log("v1." + minor + ".0");
} else {
  const [version, destination] = process.argv.slice(2);
  const privatePEM = process.env.DEMO_SIGNING_KEY_PEM;
  delete process.env.DEMO_SIGNING_KEY_PEM;
  if (!destination || !privatePEM) {
    throw new Error("Set DEMO_SIGNING_KEY_PEM and run node tools/build-release.mjs <x.y.z> <new-output-dir>");
  }
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extension), "utf8"));
  const baseline = manifest.version;
  if (compareVersions(version, baseline) < 0) throw new Error("Release precedes the checked-out extension");
  if (version.split(".").some((part) => Number(part) > 65535)) throw new Error("Chrome manifest version component exceeds 65535");
  const source = await readFile(new URL("active.js", extension), "utf8");
  const declaration = 'export const version = "' + baseline + '";';
  if (source.split(/\r?\n/).filter((line) => line === declaration).length !== 1) {
    throw new Error("Expected one active.js version declaration matching the bootstrap manifest");
  }
  const code = Buffer.from(source.replace(declaration, 'export const version = "' + version + '";'));
  const trust = await readFile(new URL("trust.json", extension));
  const assets = await createUpdate(version, code, privatePEM, JSON.parse(trust));

  const allowed = [...IMMUTABLE_FILES, "vendor/LICENSE.fflate"];
  const files = Object.fromEntries(await Promise.all(allowed.map(async (name) =>
    ["extension/" + name, await readFile(new URL(name, extension))])));
  files["extension/manifest.json"] = Buffer.from(JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  files["extension/active.js"] = code;
  files["extension/install.json"] = Buffer.from(assets["install.json"]);
  const installZip = zipSync(files, { level: 6 });
  const dir = resolve(destination);
  await mkdir(dir);
  for (const name of ["update.json", "update.sig", "update.zip"]) {
    await writeFile(resolve(dir, name), assets[name], { flag: "wx" });
  }
  await writeFile(resolve(dir, "auto-update-https.zip"), installZip, { flag: "wx" });
  console.log("v" + version + ": signed update and install ZIP verified against extension/trust.json");
}
