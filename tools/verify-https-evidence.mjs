import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = async (filename) => JSON.parse(await readFile(new URL("../evidence/https/" + filename, import.meta.url), "utf8"));

const first = await read("guard-after.json");
const held = await read("guard-next.json");
const reused = await read("guard-reuse.json");
const rejected = await read("guard-unexpected-commit.json");
const disk = await read("guard-disk.json");
const setup = await read("guard-setup.json");
assert.equal(setup.permissionWasNotModified, true);
assert.equal(setup.scheduled.periodInMinutes, 0.5);

const has = (state, phase, reason) => state.events.some((event) => event.phase === phase && (!reason || event.reason === reason));
assert.ok(has(first, "release-checked", "alarm"));
assert.ok(has(first, "downloaded-verified-unpacked", "alarm"));
assert.equal(first.candidate.version, "0.1.2");
assert.equal(first.permission, "not-selected");
assert.equal(first.status.phase, "permission-required");
assert.equal(first.badge, "!");
assert.equal(first.tabs.length, 1);
assert.equal(first.tabs[0].active, false);
assert.ok(first.events.some((event) => event.phase === "updater-opened" && event.tabId === first.tabs[0].id && !event.requestedActive));

assert.ok(has(held, "permission-required", "alarm"));
assert.deepEqual(held.tabs, first.tabs);
assert.equal(held.events.filter((event) => event.phase === "updater-opened").length, 1);
assert.ok(!has(held, "updater-reused"));

assert.equal((await read("guard-reuse-setup.json")).permissionWasNotModified, true);
assert.ok(reused.events.some((event) => event.phase === "updater-reused" && event.tabId === first.tabs[0].id && !event.requestedActive));
assert.equal(reused.tabs.length, 1);
assert.equal(reused.tabs[0].active, false);
assert.ok(!has(reused, "execution-confirmed"));
assert.equal(disk.before, disk.after);
assert.equal(rejected.commit.error.name, "FolderValidationError");
assert.equal(rejected.hash, disk.after);
assert.ok(rejected.unchangedBoot && rejected.unchangedVersion);
assert.ok((await read("guard-stopped.json")).stopped);
console.log("PASS: published release, background tab open and reuse, permission-required badge, unchanged disk and rejected commit");

const liveSetup = await read("live-setup.json");
const live = await read("live-worker.json");
const livePage = await read("live-page.json");
const liveDisk = await read("live-disk.json");
const liveUI = await read("live-ui.json");
const verifiedUpdate = (worker, afterHash) => {
  assert.equal(worker.receipt?.status, "executed");
  assert.equal(worker.receipt.version, "0.1.2");
  assert.equal(worker.receipt.sha256, afterHash);
  assert.equal(worker.transfer, null);
  assert.ok(worker.events.some((event) => event.phase === "execution-confirmed" &&
    event.version === worker.receipt.version && event.sha256 === afterHash && event.bootId === worker.receipt.bootId));
  assert.equal(worker.tabs.length, 1);
  assert.equal(worker.tabs[0].active, false);
};
const verifiedPage = (page, worker) => {
  assert.equal(page.beforePermission, "granted");
  assert.equal(page.currentPermission, "granted");
  assert.equal(page.updateActivation, "false");
  assert.equal(page.outcome, "updated");
  assert.ok(page.backupReleased);
  assert.notEqual(page.beforeBootId, worker.receipt.bootId);
};
assert.equal(liveSetup.inheritedPermission, "granted");
assert.equal(liveSetup.version, "0.1.0");
assert.equal(liveSetup.enabled, false);
assert.equal(liveDisk.before, liveSetup.beforeHash);
assert.notEqual(liveDisk.before, liveDisk.after);
assert.equal(liveDisk.after, first.candidate.sha256);
assert.deepEqual(liveDisk.changedFiles, ["active.js"]);
assert.equal(liveDisk.comparedFiles, 16);
assert.ok(has(live, "downloaded-verified-unpacked", "alarm"));
assert.ok(live.events.some((event) => event.phase === "updater-opened" && event.tabId === live.tabs[0].id && !event.requestedActive));
verifiedUpdate(live, liveDisk.after);
verifiedPage(livePage, live);
assert.equal(liveUI.version, live.receipt.version);
assert.equal(liveUI.bootId, live.receipt.bootId);
assert.match(liveUI.demo, /v0\.1\.2/);
assert.match(liveUI.proof, /6 × 7 = 42/);
console.log("PASS: unattended release update changed only active.js and executed v0.1.2");

const reuseLive = await read("reuse-worker.json");
const closed = await read("restart-closed.json");
verifiedUpdate(reuseLive, closed.reuseHash);
assert.ok(reuseLive.events.some((event) => event.phase === "updater-reused" && event.tabId === reuseLive.tabs[0].id && !event.requestedActive));
const restarted = await read("restart-worker.json");
const restartDisk = await read("restart-disk.json");
assert.equal(closed.browserProcesses, 0);
assert.equal(closed.beforeHash, liveDisk.before);
assert.equal(restartDisk.after, liveDisk.after);
assert.ok(has(restarted, "release-checked", "alarm"));
verifiedUpdate(restarted, restartDisk.after);
verifiedPage(await read("restart-page.json"), restarted);
const retained = await read("restart-retained-worker.json");
assert.ok(has(retained, "release-checked", "browser-startup"));
assert.equal(retained.status.phase, "up-to-date");
assert.equal(retained.tabs.length, 0);
console.log("PASS: actual update on reused tab and after full Chrome restart; retained target checked on startup");
