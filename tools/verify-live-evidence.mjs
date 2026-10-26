import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (name) => JSON.parse(await readFile(new URL(`../evidence/${name}`, import.meta.url), "utf8"));
const blocked = await read("background-blocked.json");
assert.equal(blocked.status.reason, "alarm");
assert.equal(blocked.status.phase, "permission-required");
assert.equal(blocked.permission, "prompt");
assert.equal(blocked.pending.version, "0.1.1");
assert.ok(blocked.events.some((event) => event.phase === "downloaded-verified-unpacked" && event.reason === "alarm" && event.targetVersion === "0.1.1"));
assert.ok(!blocked.events.some((event) => event.phase === "written-and-verified"));
console.log("PASS: background alarm downloaded and unpacked v0.1.1, without writing while permission was prompt");

const probe = await read("background-permission-probe.json");
assert.ok(probe.events.some((event) => event.phase === "test-background-requestPermission" && event.query === "prompt" && event.result === "prompt"));
console.log("PASS: requestPermission from a real background alarm remained prompt");

const resumed = await read("resumed-v0.1.1.json");
assert.equal(resumed.receipt.version, "0.1.1");
assert.equal(resumed.receipt.status, "executed");
assert.ok(resumed.events.some((event) => event.phase === "written-and-verified" && event.reason === "permission-click" && event.targetVersion === "0.1.1"));
console.log("PASS: the permission button applied the stored v0.1.1 candidate and the new worker executed");

const automatic = await read("alarm-applied-v0.1.2.json");
assert.equal(automatic.receipt.version, "0.1.2");
assert.equal(automatic.receipt.status, "executed");
assert.ok(automatic.events.some((event) => event.phase === "test-ui-kept-open" && event.permission === "granted"));
assert.ok(automatic.events.some((event) => event.phase === "written-and-verified" && event.reason === "alarm" && event.fromVersion === "0.1.1" && event.targetVersion === "0.1.2"));
assert.ok(automatic.events.some((event) => event.phase === "execution-confirmed" && event.version === "0.1.2"));
console.log("PASS: an alarm applied v0.1.2 without an update click while the authorized UI was open");

const bad = await read("corrupted-zip.json");
const disk = await read("disk-after-update.json");
assert.equal(bad.status.name, "IntegrityError");
assert.equal(bad.status.reason, "alarm");
assert.equal(bad.receipt.version, "0.1.2");
assert.equal(bad.receipt.sha256, disk.SHA256);
assert.ok(bad.events.some((event) => event.phase === "release-checked" && event.latest === "0.1.3"));
assert.ok(!bad.events.some((event) => event.phase === "written-and-verified" && event.targetVersion === "0.1.3"));
console.log("PASS: the corrupted v0.1.3 ZIP was rejected and the v0.1.2 disk hash was preserved");

const stopped = await read("monitor-stopped.json");
assert.equal(stopped.uiVersion, "0.1.2");
assert.equal(stopped.state.enabled, false);
assert.equal(stopped.state.alarm, undefined);
assert.equal(stopped.state.recovery, false);
console.log("PASS: the final updated code executed in the UI and the test monitor was stopped");
