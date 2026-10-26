import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync } from "../extension/vendor/fflate.js";
import { sha256 } from "../extension/core.js";
import { REPOSITORY } from "../extension/config.js";

if (!process.argv[2]) throw new Error("Usage: node tools/build-fixtures.mjs <private-fixture-output-directory>");
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
const encoder = new TextEncoder();

function sourceFor(version, index) {
  const source = index % 2 ? "B" : "A";
  const fn = `runSource${source}`;
  const expression = source === "A" ? '`A 専用関数: 6 × 7 = ${6 * 7}`' : '`B 専用関数: ${["GITHUB", "RELEASE", "EXECUTED"].join(" / ")}`';
  return encoder.encode(`export const version = ${JSON.stringify(version)};\nexport const sourceId = ${JSON.stringify(source)};\nexport const implementationName = ${JSON.stringify(fn)};\nfunction ${fn}() { return ${expression}; }\nexport function runSource(element) {\n  element.dataset.source = sourceId;\n  element.querySelector("h2").textContent = "Hello from Source ${source}! v" + version;\n  const proof = ${fn}();\n  element.querySelector("p").textContent = proof;\n  return proof;\n}\n`);
}

await writeFile(new URL("../extension/trust.json", import.meta.url), `${JSON.stringify(publicKey, null, 2)}\n`);
for (let index = 0; index < 4; index++) {
  const version = `0.1.${index}`;
  const tag = `v${version}`;
  const code = sourceFor(version, index);
  const zip = zipSync({ "active.js": code }, { level: 6 });
  const info = { format: 1, repository: REPOSITORY, version, tag, file: { path: "active.js", bytes: code.length, sha256: await sha256(code) }, zip: { bytes: zip.length, sha256: await sha256(zip) } };
  const raw = encoder.encode(`${JSON.stringify(info, null, 2)}\n`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, raw));
  const directory = resolve(output, tag);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "update.zip"), zip);
  await writeFile(resolve(directory, "update.json"), raw);
  await writeFile(resolve(directory, "update.sig"), signature);
  if (index === 0) {
    await writeFile(new URL("../extension/active.js", import.meta.url), code);
    await writeFile(new URL("../extension/install.json", import.meta.url), `${JSON.stringify({ version, sha256: info.file.sha256 }, null, 2)}\n`);
  }
  console.log(`${tag}: signed ZIP fixture generated (${zip.length} bytes)`);
}
console.log("Public key saved in extension/trust.json. Private key remained non-exportable and was not written to disk.");
