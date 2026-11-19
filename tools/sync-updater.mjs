import { readFile, writeFile } from "node:fs/promises";

const check = process.argv.includes("--check");
for (const file of ["bridge.js", "core.js", "store.js", "package.js"]) {
  const source = await readFile(new URL("../extension/" + file, import.meta.url));
  const target = new URL("../docs/updater/" + file, import.meta.url);
  if (check) {
    const copy = await readFile(target);
    if (!source.equals(copy)) throw new Error("Updater copy differs: " + file);
  } else await writeFile(target, source);
}
