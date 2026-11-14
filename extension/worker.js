import { version } from "./active.js";
import { LOCK, isAllowedWebSender, isUpdaterTab, isValidMessage, updaterURL } from "./bridge.js";
import { CHECK_ALARM, CHECK_MINUTES } from "./config.js";
import { loadBundle, namedError, readOwn, sha256 } from "./core.js";
import { compareVersions, downloadCandidate, latestRelease } from "./release.js";
import { load, readEvents, record, save, saveAll } from "./store.js";

const bootId = crypto.randomUUID();
const locked = (task) => navigator.locks.request(LOCK, task);
const encoded = (bytes) => Array.from(bytes);
const decodeJSON = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
const ownHash = async () => sha256(await readOwn("active.js"));

async function status(phase, data = {}) {
  const event = { phase, executingVersion: version, ...data };
  await save("status", { at: new Date().toISOString(), ...event });
  await record(event);
  const attention = ["permission-required", "folder-required", "error", "recovery-required"];
  await chrome.action.setBadgeText({ text: attention.includes(phase) ? "!" : "" });
}

async function ensureAlarm() {
  if (await load("enabled") && !await chrome.alarms.get(CHECK_ALARM)) {
    await chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 0.5, periodInMinutes: CHECK_MINUTES });
  }
}

async function stopMonitoring() {
  await save("enabled", false);
  await chrome.alarms.clear(CHECK_ALARM);
}

async function openUpdater(active) {
  const id = chrome.runtime.id;
  const url = updaterURL(id);
  const tabs = await chrome.tabs.query({ url: url.split("?")[0] + "*" });
  const known = await load("updaterTab");
  const tab = tabs.find((item) => item.id === known && isUpdaterTab(item, id))
    ?? tabs.find((item) => isUpdaterTab(item, id));
  let tabId;
  if (tab) {
    tabId = tab.id;
    if (active) {
      if (tab.windowId !== chrome.windows.WINDOW_ID_NONE) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } else if (tab.status !== "loading") {
      // A fresh document also wakes a tab Chrome has frozen or discarded.
      await chrome.tabs.reload(tab.id);
    }
  } else {
    tabId = (await chrome.tabs.create({ url, active })).id;
  }
  await save("updaterTab", tabId);
  await record({ phase: tab ? "updater-reused" : "updater-opened", tabId, requestedActive: active });
}

async function verifyInstalled(hash) {
  const receipt = await load("receipt");
  if (receipt?.status === "written") {
    const transfer = await load("transfer");
    if (transfer?.fromVersion === version && transfer.beforeHash === hash) {
      await saveAll({ transfer: null, receipt: transfer.previousReceipt ?? null, blocked: null, enabled: false });
      await chrome.alarms.clear(CHECK_ALARM);
      await status("restored");
      return;
    }
  }
  const expected = receipt ?? decodeJSON(await readOwn("install.json"));
  if (expected.version !== version || expected.sha256 !== hash) {
    throw namedError("SourceMismatchError", "実行中の版または active.js が、記録された版と一致しません。");
  }
  if (receipt?.status === "written") {
    await saveAll({ receipt: { ...receipt, status: "executed", bootId, observedAt: new Date().toISOString() }, transfer: null });
    await record({ phase: "execution-confirmed", version, sha256: hash, bootId });
  }
}

async function wakeUpdater(reason, pending) {
  const blocked = await load("blocked");
  if (blocked) {
    await status(blocked, { reason, targetVersion: pending?.version, permission: await load("permission") });
    return;
  }
  await status("awaiting-updater", { reason, targetVersion: pending?.version });
  await openUpdater(false);
}

async function check(reason) {
  try {
    if (await load("transfer")) {
      if (await load("enabled")) await wakeUpdater(reason, await load("pending"));
      return;
    }
    if (Date.now() < (await load("retryAt") ?? 0)) return;
    await verifyInstalled(await ownHash());
    const release = await latestRelease();
    await record({ phase: "release-checked", reason, latest: release.version });
    if (compareVersions(release.version, version) <= 0) {
      await save("pending", null);
      await status("up-to-date", { reason, latest: release.version });
      return;
    }
    const revision = JSON.stringify(release.assets.filter(({ name }) => ["update.json", "update.sig", "update.zip"].includes(name))
      .map(({ name, id, updated_at }) => [name, id, updated_at]));
    let pending = await load("pending");
    if (pending?.tag !== release.tag_name || pending.revision !== revision) {
      await save("pending", null);
      pending = { ...await downloadCandidate(release, decodeJSON(await readOwn("trust.json"))), revision };
      await save("pending", pending);
      await record({ phase: "downloaded-verified-unpacked", reason, targetVersion: pending.version, sha256: pending.sha256 });
    }
    if (await load("enabled")) await wakeUpdater(reason, pending);
    else await status("downloaded", { reason, targetVersion: pending.version });
  } catch (error) {
    if (error.retryAt) await save("retryAt", error.retryAt);
    await status("error", { reason, name: error.name, message: error.message });
  }
}

async function info() {
  const receipt = await load("receipt");
  const transfer = await load("transfer");
  return {
    version, bootId, enabled: Boolean(await load("enabled")),
    pending: (await load("pending"))?.version ?? null,
    permission: (await load("permission")) ?? "not-selected",
    transfer: transfer && { token: transfer.token, fromVersion: transfer.fromVersion, targetVersion: transfer.targetVersion, beforeHash: transfer.beforeHash, targetHash: transfer.targetHash, written: receipt?.status === "written" },
    receipt: receipt && { version: receipt.version, sha256: receipt.sha256, status: receipt.status, bootId: receipt.bootId },
    status: await load("status"),
  };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) void locked(async () => { if (await load("enabled")) await check("alarm"); }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  void locked(async () => { await ensureAlarm(); if (await load("enabled")) await check("browser-startup"); }).catch(console.error);
});

async function start() {
  await ensureAlarm();
  try {
    await verifyInstalled(await ownHash());
    await record({ phase: "worker-started", version, bootId });
  } catch (error) {
    if (!await load("transfer")) throw error;
  }
  if (await load("transfer")) await status("recovery-required");
  else if ((await load("status"))?.phase === "reloading") await status("updated");
  else if (!await load("status")) await status("ready");
}
void locked(start).catch((error) => status("error", { reason: "startup", name: error.name, message: error.message }).catch(console.error));

function respond(task, sendResponse) {
  void locked(task).then(sendResponse, (error) => sendResponse({ error: { name: error.name, message: error.message } }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  return respond(async () => {
    if (message?.kind === "status") return { ...await info(), alarm: await chrome.alarms.get(CHECK_ALARM), events: (await readEvents()).slice(-50) };
    if (message?.kind === "updater") { await openUpdater(true); return true; }
    if (message?.kind === "disable") {
      await stopMonitoring();
      await status("disabled");
      return true;
    }
    if (message?.kind === "check") { await check("manual-check"); return true; }
    throw namedError("ProtocolError", "未対応の操作です。");
  }, sendResponse);
});

async function webMessage(message, sender) {
  const transfer = await load("transfer");
  switch (message.action) {
    case "info": return info();
    case "snapshot": return loadBundle();
    case "hash": return ownHash();
    case "permission": {
      await save("permission", message.permission);
      const blocked = await load("blocked");
      if (message.permission !== "granted") {
        const phase = transfer ? "recovery-required" : "permission-required";
        await save("blocked", phase);
        await status(phase, { permission: message.permission });
      } else if (blocked === "permission-required") {
        await save("blocked", null);
        await status("ready");
      }
      return true;
    }
    case "attention": {
      const phase = message.cause === "folder" ? "folder-required" : "recovery-required";
      await save("blocked", phase);
      await status(phase);
      return true;
    }
    case "unblock": {
      if (transfer) throw namedError("RecoveryError", "先に中断した更新を復旧してください。");
      await save("blocked", null);
      await status("ready");
      return true;
    }
    case "enable": {
      if (await load("blocked") || await load("permission") !== "granted" || transfer) {
        throw namedError("NotAllowedError", "先にフォルダ登録・許可または復旧を完了してください。");
      }
      await save("enabled", true);
      await ensureAlarm();
      await status("monitoring");
      return true;
    }
    case "plan": {
      const pending = await load("pending");
      if (!pending || !await load("enabled") || transfer || await load("blocked")) return null;
      const bundle = await loadBundle();
      await verifyInstalled(bundle.sha256);
      if (compareVersions(pending.version, version) <= 0 || await sha256(pending.code) !== pending.sha256 ||
          pending.sha256 === bundle.sha256) throw namedError("IntegrityError", "保存した更新候補を再検証できません。");
      return { bundle, version: pending.version, sha256: pending.sha256, code: encoded(pending.code) };
    }
    case "begin": {
      if (transfer?.token === message.token) return true;
      const pending = await load("pending");
      if (transfer || !pending || !await load("enabled") || await load("blocked") ||
          pending.sha256 !== message.targetHash || compareVersions(pending.version, version) <= 0) {
        throw namedError("UpdateChangedError", "更新候補または設定が変わりました。次の確認で再試行します。");
      }
      const hash = await ownHash();
      await verifyInstalled(hash);
      if (message.beforeHash !== hash) throw namedError("SourceMismatchError", "書き込み前に active.js が変更されました。");
      await save("transfer", {
        token: message.token, beforeHash: hash, targetHash: pending.sha256, targetVersion: pending.version,
        fromVersion: version, previousReceipt: await load("receipt"),
      });
      return true;
    }
    case "commit": {
      if (!transfer || transfer.token !== message.token || await ownHash() !== transfer.targetHash) {
        throw namedError("FolderValidationError", "Chrome の読み込み元に書き換えが反映されていません。");
      }
      const receipt = {
        version: transfer.targetVersion, sha256: transfer.targetHash, status: "written",
        writtenAt: new Date().toISOString(),
      };
      await saveAll({ receipt, pending: null, blocked: null });
      // Respond to the web page before unloading this worker.
      setTimeout(() => chrome.runtime.reload(), 400);
      await status("reloading", { targetVersion: receipt.version, tabId: sender.tab?.id }).catch(console.error);
      return true;
    }
    case "cancel": {
      if (!transfer) {
        if (message.pause) { await stopMonitoring(); await status("disabled"); }
        return true;
      }
      if (transfer.token !== message.token || await ownHash() !== transfer.beforeHash) {
        throw namedError("RecoveryError", "Chrome の読み込み元で旧版を確認できません。");
      }
      const written = (await load("receipt"))?.status === "written";
      await saveAll({ transfer: null, receipt: transfer.previousReceipt ?? null, blocked: null,
        ...(message.pause ? { enabled: false } : {}) });
      if (message.pause) await chrome.alarms.clear(CHECK_ALARM);
      if (written) setTimeout(() => chrome.runtime.reload(), 400);
      await status("restored", { version: transfer.fromVersion });
      return true;
    }
  }
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isAllowedWebSender(sender) || !isUpdaterTab({ url: sender.url }, chrome.runtime.id) ||
      !Number.isInteger(sender.tab?.id) || !isValidMessage(message)) return;
  return respond(() => webMessage(message, sender), sendResponse);
});
