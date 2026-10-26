import { version } from "./active.js";
import { CHECK_ALARM, CHECK_MINUTES } from "./config.js";
import { loadBundle, namedError, replaceActive, sha256 } from "./core.js";
import { compareVersions, downloadCandidate, latestRelease } from "./release.js";
import { load, readEvents, record, save } from "./store.js";

let busy = false;

async function status(phase, data = {}) {
  const event = { phase, executingVersion: version, ...data };
  await save("status", { at: new Date().toISOString(), ...event });
  await record(event);
  await chrome.action.setBadgeText({ text: phase === "permission-required" || phase === "error" || phase === "recovery-required" ? "!" : "" });
}

async function ensureAlarm() {
  if (await load("enabled") && !await chrome.alarms.get(CHECK_ALARM)) await chrome.alarms.create(CHECK_ALARM, { periodInMinutes: CHECK_MINUTES });
}

async function verifyInstalled(bundle) {
  const receipt = await load("receipt");
  const install = JSON.parse(new TextDecoder().decode(bundle.files["install.json"]));
  const expected = receipt?.status === "written" || receipt?.status === "executed" ? receipt : install;
  if (expected.version !== version || expected.sha256 !== await sha256(bundle.active)) throw namedError("SourceMismatchError", "実行中の版とディスク上のソースが更新記録と一致しません。");
  if (receipt?.status === "written") {
    await save("receipt", { ...receipt, status: "executed", observedAt: new Date().toISOString() });
    await record({ phase: "execution-confirmed", version, sha256: expected.sha256 });
  }
}

async function applyPending(reason) {
  const pending = await load("pending");
  if (!pending || compareVersions(pending.version, version) <= 0) return false;
  if (await load("recovery")) { await status("recovery-required", { reason }); return false; }
  const directory = await load("directory");
  const permission = directory ? await directory.queryPermission({ mode: "readwrite" }) : "not-selected";
  await record({ phase: "background-permission", reason, permission });
  if (permission !== "granted") {
    await status("permission-required", { reason, targetVersion: pending.version, permission });
    return false;
  }
  const bundle = await loadBundle();
  await verifyInstalled(bundle);
  if (await sha256(pending.code) !== pending.sha256) throw namedError("IntegrityError", "保存した更新候補の内容が一致しません。");
  const previousReceipt = await load("receipt");
  let savedBackup = false;
  try {
    await replaceActive(directory, bundle, pending.code, {
      onBackup: async (backup) => {
        await save("recovery", { ...backup, fromVersion: version, targetVersion: pending.version, previousReceipt });
        savedBackup = true;
      },
      onVerified: async () => {
        await save("receipt", { version: pending.version, sha256: pending.sha256, fromVersion: version, status: "written", writtenAt: new Date().toISOString() });
        await record({ phase: "written-and-verified", reason, fromVersion: version, targetVersion: pending.version, sha256: pending.sha256 });
      },
    });
  } catch (error) {
    if (savedBackup && error.rollback !== "failed") {
      await save("receipt", previousReceipt);
      await save("recovery", null);
    }
    throw error;
  }
  await save("pending", null);
  await status("reloading", { reason, targetVersion: pending.version });
  chrome.runtime.reload();
  return true;
}

async function run(reason, mode = "check") {
  if (busy) return { phase: "busy" };
  busy = true;
  try {
    return await navigator.locks.request("github-unpacked-self-update-lab", { ifAvailable: true }, async (lock) => {
      if (!lock) return { phase: "busy" };
      if (mode === "apply") { await applyPending(reason); return await load("status"); }
      if (Date.now() < (await load("retryAt") ?? 0)) return { phase: "rate-limit-wait" };
      if (await load("recovery")) { await status("recovery-required", { reason }); return await load("status"); }
      await verifyInstalled(await loadBundle());
      const release = await latestRelease();
      await record({ phase: "release-checked", reason, latest: release.version, executingVersion: version });
      if (compareVersions(release.version, version) <= 0) { await status("up-to-date", { reason, latest: release.version }); return await load("status"); }
      let pending = await load("pending");
      if (!pending || pending.version !== release.version) {
        const trust = await (await fetch(chrome.runtime.getURL("trust.json"))).json();
        pending = await downloadCandidate(release, trust);
        await save("pending", pending);
        await record({ phase: "downloaded-verified-unpacked", reason, targetVersion: pending.version, sha256: pending.sha256, bytes: pending.code.length });
      }
      if (await load("enabled")) await applyPending(reason);
      else await status("downloaded", { reason, targetVersion: pending.version });
      return await load("status");
    });
  } catch (error) {
    if (error.retryAt) await save("retryAt", error.retryAt);
    await status("error", { reason, name: error.name, message: error.message, rollback: error.rollback, rollbackError: error.rollbackError });
    return await load("status");
  } finally { busy = false; }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) void load("enabled").then((enabled) => enabled && run("alarm"));
});
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); });
chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const task = async () => {
    if (message.kind === "status") return { executingVersion: version, enabled: Boolean(await load("enabled")), pending: (await load("pending"))?.version ?? null, status: await load("status"), recovery: Boolean(await load("recovery")), alarm: await chrome.alarms.get(CHECK_ALARM), events: (await readEvents()).slice(-50) };
    if (message.kind === "enable") { await save("enabled", true); await ensureAlarm(); return run("enable"); }
    if (message.kind === "disable") { await save("enabled", false); await chrome.alarms.clear(CHECK_ALARM); await status("disabled"); return true; }
    if (message.kind === "check") return run("manual-check");
    if (message.kind === "apply") return run("permission-click", "apply");
    throw new Error("Unknown message");
  };
  task().then(sendResponse, (error) => sendResponse({ error: { name: error.name, message: error.message } }));
  return true;
});

async function start() {
  await ensureAlarm();
  const bundle = await loadBundle();
  const recovery = await load("recovery");
  const receipt = await load("receipt");
  await verifyInstalled(bundle);
  if (recovery && receipt?.version === version && receipt.sha256 === await sha256(bundle.active)) await save("recovery", null);
  await record({ phase: "worker-started", version, recovery: Boolean(await load("recovery")) });
  await status(await load("recovery") ? "recovery-required" : "ready", { reason: "startup" });
}
void start().catch((error) => status("error", { reason: "startup", name: error.name, message: error.message }));
