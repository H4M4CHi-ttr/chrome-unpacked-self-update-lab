import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256 } from "../extension/core.js";
import { packageInventory } from "../extension/package.js";

const installed = (file) => readFile(new URL("../extension/" + file, import.meta.url));

test("a fresh installation contains its own settings page and only requests access to release hosts", async () => {
  const manifest = JSON.parse(await installed("manifest.json"));
  assert.deepEqual(manifest.permissions, ["alarms"]);
  assert.equal(manifest.externally_connectable, undefined);
  assert.deepEqual(manifest.host_permissions.slice().sort(), [
    "https://api.github.com/*", "https://github.com/*", "https://release-assets.githubusercontent.com/*",
  ]);
  assert.equal(manifest.options_ui.open_in_tab, true);
  const { files } = await packageInventory(await installed("install.json"));
  const page = manifest.options_ui.page;
  const html = await installed(page);
  assert.equal(await sha256(html), files[page]);
  for (const [, script] of html.toString().matchAll(/<script[^>]+src="([^"]+)"/g)) {
    assert.equal(await sha256(await installed(script)), files[script]);
  }
});

test("the release builder starts at the manifest baseline and increments only the patch", () => {
  const builder = fileURLToPath(new URL("../tools/build-release.mjs", import.meta.url));
  const next = (tag) => spawnSync(process.execPath, [builder, "--next", tag], { encoding: "utf8" });

  for (const [tag, expected] of [
    ["v1.66.0", "v2.0.0"],
    ["v2.0.0", "v2.0.1"],
    ["v2.0.9", "v2.0.10"],
    ["v2.4.17", "v2.4.18"],
  ]) {
    const run = next(tag);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), expected);
  }

  for (const tag of ["2.0.0", "v2.0.01", "v2.0.65535"]) {
    const run = next(tag);
    assert.equal(run.error, undefined);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
  }
});
