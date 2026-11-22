import { version } from "./active.js";
import { CHECK_ALARM, CHECK_MINUTES, LOCK, PRIVATE_REPOSITORY, RELEASE_TOKEN_KEY } from "./config.js";
import { namedError, readOwn, sha256 } from "./core.js";
import {
  PACKAGE_FORMAT, PACKAGE_INDEX, PACKAGE_METADATA, PACKAGE_SIGNATURE, PACKAGE_ZIP,
  assertCompatibleManifest, decodeJSON, hashFiles, hashInventory, readOwnPackage, replacePackage, restorePackage,
} from "./package.js";
import { compareVersions, downloadPackage, latestRelease } from "./release.js";
import { load, readEvents, record, save, saveAll } from "./store.js";

const bootId = crypto.randomUUID();
const { version: manifestVersion, version_name: displayVersion = manifestVersion } = chrome.runtime.getManifest();
const locked = (task) => navigator.locks.request(LOCK, task);
const executing = (bundle) => manifestVersion === version && displayVersion === version && bundle.version === version;

async function status(phase, data = {}) {
  const event = { phase, executingVersion: version, ...data };
  await save("status", { at: new Date().toISOString(), ...event });
  await record(event);
  const attention = ["permission-required", "folder-required", "recovery-required", "error"].includes(phase);
  const noApplicableUpdate = phase === "up-to-date" || phase === "package-unavailable";
  const needsGrant = noApplicableUpdate && await load("enabled") &&
    await permissionOf(await load("directory")) !== "granted";
  await chrome.action.setBadgeText({ text: attention || needsGrant ? "!" : "" });
}

async function ensureAlarm() {
  const enabled = await load("enabled");
  const alarm = await chrome.alarms.get(CHECK_ALARM);
  if (enabled && !alarm) await chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 0.5, periodInMinutes: CHECK_MINUTES });
  if (!enabled && alarm) await chrome.alarms.clear(CHECK_ALARM);
}

async function permissionOf(directory) {
  return directory ? directory.queryPermission({ mode: "readwrite" }) : "not-selected";
}

async function installed() {
  const bundle = await readOwnPackage();
  const receipt = await load("receipt");
  if (!executing(bundle) || (receipt && (receipt.version !== version || receipt.sha256 !== bundle.sha256))) {
    throw namedError("SourceMismatchError", "実行中のコードと manifest、ディスク上のパッケージの版や内容が一致しません。");
  }
  return bundle;
}

async function verifyCandidate(pending, bundle) {
  const hashes = await hashFiles(pending.files);
  if (await hashInventory(hashes) !== pending.sha256 || compareVersions(pending.version, bundle.version) <= 0) {
    throw namedError("IntegrityError", "保存したパッケージを再検証できません。");
  }
  if (hashes["trust.json"] !== bundle.files["trust.json"] || hashes["poc-identity.json"] !== bundle.files["poc-identity.json"]) {
    throw namedError("PackageError", "公開鍵または拡張機能の識別情報を変更するには、新しい ZIP から読み込み直してください。");
  }
  assertCompatibleManifest(decodeJSON(await readOwn("manifest.json")), pending.files["manifest.json"], pending.version);
}

async function start() {
  await ensureAlarm();
  const backup = await load("recovery");
  if (backup) {
    // A terminated worker may leave a fully written package or a partial one.
    const disk = await readOwnPackage().catch(() => null);
    if (disk?.version === backup.targetVersion && disk.sha256 === backup.targetHash) {
      if (executing(disk) && bootId !== backup.writerBootId) {
        const receipt = { format: PACKAGE_FORMAT, status: "executed", version, sha256: disk.sha256, bootId };
        await saveAll({ receipt, recovery: null, pending: null, blocked: null });
        await record({ phase: "execution-confirmed", version, manifestVersion, sha256: disk.sha256, bootId });
        await status("updated");
        return;
      }
      if (!(await load("receipt"))?.reloadRetried) {
        await save("receipt", { status: "written", version: disk.version, sha256: disk.sha256, reloadRetried: true });
        chrome.runtime.reload();
        return;
      }
    }
    await status("recovery-required", { targetVersion: backup.targetVersion });
    return;
  }
  await installed();
  await record({ phase: "worker-started", version, manifestVersion, bootId });
  if (!await load("status")) await status("ready");
}

async function applyPending(reason) {
  if (await load("recovery")) { await status("recovery-required", { reason }); return; }
  const pending = await load("pending");
  if (!pending) return;
  if (await load("blocked")) { await status("folder-required", { reason }); return; }
  const directory = await load("directory");
  const permission = await permissionOf(directory);
  if (permission !== "granted") {
    await status("permission-required", { reason, targetVersion: pending.version, permission });
    return;
  }
  const bundle = await installed();
  await verifyCandidate(pending, bundle);
  const previousReceipt = await load("receipt");
  let backup;
  try {
    await replacePackage(directory, bundle, pending.files, {
      targetHash: pending.sha256,
      readMarker: async () => sha256(await readOwn(PACKAGE_INDEX)),
      onBackup: async (snapshot) => {
        const saved = { ...snapshot, writerBootId: bootId, id: crypto.randomUUID(), fromVersion: version,
          targetVersion: pending.version, previousReceipt };
        await save("recovery", saved);
        backup = saved;
      },
    });
    if ((await readOwnPackage()).sha256 !== pending.sha256) {
      throw namedError("FolderValidationError", "Chrome の読み込み元に書き換えが反映されていません。");
    }
    await saveAll({ receipt: { format: PACKAGE_FORMAT, status: "written", version: pending.version, sha256: pending.sha256 }, pending: null });
  } catch (error) {
    if (backup) {
      try {
        await restorePackage(backup);
        await saveAll({ receipt: previousReceipt ?? null, recovery: null });
      } catch (restoreError) {
        await status("recovery-required", { reason, message: error.message, restoreError: restoreError.message });
        return;
      }
    }
    if (["FolderValidationError", "SourceMismatchError", "NotFoundError"].includes(error.name)) {
      await save("blocked", true);
      await status("folder-required", { reason, message: error.message });
      return;
    }
    if (error.name === "NotAllowedError") {
      await status("permission-required", { reason, permission: await permissionOf(directory), message: error.message });
      return;
    }
    throw error;
  }
  await status("reloading", { reason, fromVersion: version, targetVersion: pending.version, writerBootId: bootId });
  chrome.runtime.reload();
}

async function check(reason) {
  if (await load("recovery")) { await status("recovery-required", { reason }); return; }
  if (Date.now() < (await load("retryAt") ?? 0)) return;
  const token = PRIVATE_REPOSITORY ? await load(RELEASE_TOKEN_KEY) : undefined;
  if (PRIVATE_REPOSITORY && !token) {
    throw namedError("ReleaseAccessError", "プライベートリポジトリの確認には、拡張機能で GitHub アクセストークンを登録してください。");
  }
  const bundle = await installed();
  const release = await latestRelease(token);
  await record({ phase: "release-checked", reason, latest: release.version });
  if (compareVersions(release.version, version) <= 0) {
    await save("pending", null);
    await status("up-to-date", { reason, latest: release.version });
    return;
  }
  const revision = JSON.stringify(release.assets.filter(({ name }) => [PACKAGE_METADATA, PACKAGE_SIGNATURE, PACKAGE_ZIP].includes(name))
    .map(({ name, id, updated_at }) => [name, id, updated_at]));
  let pending = await load("pending");
  if (pending?.format !== PACKAGE_FORMAT || pending.tag !== release.tag_name || pending.revision !== revision) {
    await save("pending", null);
    if (!release.assets.some(({ name }) => name === PACKAGE_METADATA)) {
      await status("package-unavailable", { reason, latest: release.version });
      return;
    }
    pending = { ...await downloadPackage(release, decodeJSON(await readOwn("trust.json")), token), revision };
    await verifyCandidate(pending, bundle);
    await save("pending", pending);
    await record({ phase: "downloaded-verified-unpacked", reason, targetVersion: pending.version, sha256: pending.sha256 });
  }
  if (await load("enabled")) await applyPending(reason);
  else await status("downloaded", { reason, targetVersion: pending.version });
}

async function run(task, reason) {
  return locked(async () => {
    try { return await task(); }
    catch (error) {
      if (error.retryAt) await save("retryAt", error.retryAt);
      await status("error", { reason, name: error.name, message: error.message });
      throw error;
    }
  });
}

async function showSettingsForReauthorization() {
  if (await load("recovery") || await load("blocked")) return;
  const permission = await permissionOf(await load("directory"));
  if (permission === "not-selected") return;
  const shown = await load("reauthorizationShown");
  if (permission === "granted") {
    if (shown) await save("reauthorizationShown", false);
    return;
  }
  await chrome.action.setBadgeText({ text: "!" });
  if (shown) return;
  try {
    await chrome.runtime.openOptionsPage();
    await save("reauthorizationShown", true);
  } catch (error) {
    console.error(error);
  }
}

function automaticCheck(reason) {
  void run(async () => {
    if (!await load("enabled")) return;
    await showSettingsForReauthorization();
    await check(reason);
  }, reason).catch(console.error);
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === CHECK_ALARM) automaticCheck("alarm"); });
chrome.runtime.onStartup.addListener(() => automaticCheck("browser-startup"));
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") void chrome.runtime.openOptionsPage().catch(console.error);
});
void run(start, "startup").catch(console.error);

async function command(kind) {
  switch (kind) {
    case "status": {
      const enabled = await load("enabled");
      return {
        version, manifestVersion, bootId, enabled: Boolean(enabled), enableOnFirstGrant: enabled === undefined,
        pending: (await load("pending"))?.version ?? null, receipt: await load("receipt"),
        status: await load("status"), alarm: await chrome.alarms.get(CHECK_ALARM), events: (await readEvents()).slice(-50),
      };
    }
    case "enable":
      if (await load("recovery") || await load("blocked") || await permissionOf(await load("directory")) !== "granted") {
        throw namedError("NotAllowedError", "先にフォルダの登録・再許可または復元を完了してください。");
      }
      await save("enabled", true);
      await ensureAlarm();
      await status("monitoring");
      await applyPending("enable");
      return true;
    case "disable":
      await save("enabled", false);
      await ensureAlarm();
      await status("disabled");
      return true;
    case "check": await check("manual-check"); return true;
    case "apply": await applyPending("manual-apply"); return true;
    case "folder-ready": {
      if (await load("recovery")) return true;
      if (await load("reauthorizationShown")) await save("reauthorizationShown", false);
      let enabled = await load("enabled");
      if (enabled === undefined && !await load("blocked") && await permissionOf(await load("directory")) === "granted") {
        enabled = true;
        await save("enabled", enabled);
        await ensureAlarm();
      }
      if (enabled && await load("pending")) await applyPending("folder-ready");
      else await status(enabled ? "monitoring" : "ready");
      return true;
    }
    default: throw namedError("ProtocolError", "未対応の操作です。");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/, 1)[0] !== chrome.runtime.getURL("popup.html")) return;
  void run(() => command(message?.kind), message?.kind).then(respond,
    (error) => respond({ error: { name: error.name, message: error.message } }));
  return true;
});
