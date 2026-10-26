import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const root = new URL("../experiments/permission-isolation/", import.meta.url);
for (const [name, mode, versions] of [
  ["hot-module.json", "hot-module", ["0.2.1", "0.2.2"]],
  ["external-https.json", "external-https", ["0.2.3", "0.2.4"]],
  ["persistent-updates.json", "external-https", ["0.2.3", "0.2.4"]],
]) {
  const report = JSON.parse(await readFile(new URL(`evidence/${name}`, root), "utf8"));
  assert.equal(report.mode, mode);
  const steps = report.events.filter((event) => event.phase === "updated");
  assert.deepEqual(steps.map((step) => step.version), versions);
  for (const step of steps) {
    assert.equal(step.documentId, report.documentId);
    assert.equal(step.beforePermission, "granted");
    assert.equal(step.afterPermission, "granted");
    assert.equal(step.userActivation, false, "automatic updates must occur after the click activation expires");
    const expected = createHash("sha256").update(await readFile(new URL(`extension/variants/${step.version}.js`, root))).digest("hex");
    assert.equal(step.afterHash, expected);
    assert.notEqual(step.beforeHash, step.afterHash);
    if (mode === "hot-module") {
      assert.equal(step.beforeBootId, step.afterBootId);
      assert.ok(report.events.some((event) => event.phase === "new-module-executed" && event.version === step.version && event.proof));
    } else {
      assert.notEqual(step.beforeBootId, step.afterBootId);
      assert.equal(step.compiledVersion, step.version);
    }
  }
  assert.ok(report.events.some((event) => event.phase === "sequence-complete" && event.permission === "granted"));
  assert.equal(report.events.filter((event) => event.phase === "requestPermission").length, 0);
  console.log(`PASS: ${mode}, two real source changes and executions, permission retained without a reauthorization request`);
}

const restart = JSON.parse(await readFile(new URL("evidence/browser-restart-after-always-allow.json", root), "utf8"));
assert.equal(restart.Before.AllTemporaryChromeProcessesExited, true);
assert.equal(restart.Before.AfterUserSelectedAlwaysAllow, true);
assert.equal(restart.After.Browser.length, 1);
const restored = JSON.parse(await readFile(new URL("evidence/persistent-after-restart.json", root), "utf8"));
assert.equal(restored.permission, "granted");
assert.ok(restored.report.events.some((event) => event.phase === "page-started" && event.restoredHandle && event.permission === "granted"));
assert.equal(restored.report.events.filter((event) => event.phase === "requestPermission").length, 0);
const persistent = JSON.parse(await readFile(new URL("evidence/persistent-updates.json", root), "utf8"));
const disk = JSON.parse(await readFile(new URL("evidence/disk-after-persistent-updates.json", root), "utf8"));
assert.equal(persistent.events.filter((event) => event.phase === "updated").at(-1).afterHash, disk.SHA256);
const ui = JSON.parse(await readFile(new URL("evidence/target-ui-after-external.json", root), "utf8"));
assert.equal(ui.heading, "Hello from Source A! v0.2.4");
assert.equal(ui.proof, "A 専用関数: 6 × 7 = 42");
console.log("PASS: after full Chrome restart, the HTTPS page restored granted permission and performed two updates without requestPermission");
