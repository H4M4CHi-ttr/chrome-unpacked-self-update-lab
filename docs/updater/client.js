import { LOCK, PROTOCOL } from "./bridge.js";
import { namedError, readBytes, replaceActive, restoreRecovery, sha256, validateDirectory } from "./core.js";
import { PACKAGE_FORMAT, replacePackage, restorePackage, validatePackageDirectory, verifyPackageDisk } from "./package.js";
import { load, save } from "./store.js";

const $ = (selector) => document.querySelector(selector);
const targetId = new URLSearchParams(location.search).get("id");
const idOK = /^[a-p]{32}$/.test(targetId ?? "");
const key = (name) => targetId + ":" + name;
const locked = (task) => navigator.locks.request(LOCK + ":" + targetId, task);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (value) => { $("#status").textContent = value; };
document.documentElement.dataset.documentId = crypto.randomUUID();
let directory, recovery, state, permission, working = false, errorMessage = "";
const isPackage = (update) => update?.format === PACKAGE_FORMAT;

async function rpc(action, data) {
  if (!idOK || !globalThis.chrome?.runtime?.sendMessage) {
    throw namedError("ConnectionError", "拡張機能のメニューからこのページを開いてください。");
  }
  const response = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(targetId, { protocol: PROTOCOL, action, ...data }, (value) => {
      if (chrome.runtime.lastError) reject(namedError("ConnectionError", chrome.runtime.lastError.message));
      else resolve(value);
    });
  });
  if (response?.error) throw namedError(response.error.name, response.error.message);
  if (response === undefined) throw namedError("ConnectionError", "対象の拡張機能に接続できません。");
  return response;
}

async function refresh() {
  directory = await load(key("directory"));
  recovery = await load(key("recovery"));
  permission = directory ? await directory.queryPermission({ mode: "readwrite" }) : "not-selected";
  const labels = { granted: "許可あり", prompt: "再許可が必要", denied: "拒否", "not-selected": "未登録" };
  $("#permission").textContent = labels[permission];
  $("#restore").hidden = !recovery;
  $("#restore").disabled = working || !recovery;
  state = await rpc("info");
  $("#version").textContent = "v" + state.version;
  $("#enabled").textContent = state.enabled ? "有効" : "停止中";
  $("#pick").disabled = working || !state || Boolean(recovery || state.transfer);
  $("#grant").disabled = working || !directory;
  $("#enable").disabled = working || state.enabled || permission !== "granted" || Boolean(recovery || state.transfer);
}

async function action(task) {
  if (working) return;
  working = true;
  errorMessage = "";
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  try { await task(); }
  catch (error) { errorMessage = error.name + ": " + error.message; say(errorMessage); }
  finally {
    working = false;
    try { await refresh(); }
    catch (error) { if (!errorMessage) say(error.name + ": " + error.message); }
  }
}

async function confirmReload(backup) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const now = await rpc("info").catch(() => null);
    if (now?.receipt?.status === "executed" && now.receipt.sha256 === backup.targetHash && now.bootId !== backup.bootId &&
        (!isPackage(backup) || (isPackage(now.receipt) && now.manifestVersion === now.receipt.version))) {
      await save(key("recovery"), null);
      recovery = null;
      document.documentElement.dataset.outcome = "updated";
      document.documentElement.dataset.permission = await directory.queryPermission({ mode: "readwrite" });
      say("v" + now.version + " の起動を確認しました。");
      return;
    }
    await sleep(250);
  }
  throw namedError("RecoveryError", "新版の起動を確認できません。次にこのページを開くと中断した処理を照合します。");
}

async function completeTransfer() {
  const current = await rpc("info");
  if (!current.transfer) {
    if (!recovery) return;
    const hash = await rpc("hash");
    if (current.receipt?.status === "executed" && current.receipt.sha256 === recovery.targetHash && hash === recovery.targetHash) {
      await rpc("unblock");
      await confirmReload(recovery);
      return;
    }
    // A backup can survive closing the page before begin reached the worker.
    // Only clear it if the selected file still has the old bytes.
    if (hash !== recovery.beforeHash || !await diskMatches(recovery, false)) {
      throw namedError("RecoveryError", "中断時の記録が一致しません。バックアップを確認してください。");
    }
    await save(key("recovery"), null);
    recovery = null;
    await rpc("unblock");
    return;
  }
  if (!recovery || current.transfer.token !== recovery.token || current.transfer.targetHash !== recovery.targetHash ||
      current.transfer.beforeHash !== recovery.beforeHash) {
    throw namedError("RecoveryError", "HTTPS ページ側に対応するバックアップがありません。");
  }
  const packageHash = await rpc("hash").catch((error) => {
    if (isPackage(recovery) && error.name !== "ConnectionError") return null;
    throw error;
  });
  if (packageHash === recovery.targetHash && await diskMatches(recovery, true) && (current.enabled || current.transfer.written)) {
    await rpc("commit", { token: recovery.token });
    await confirmReload(recovery);
    return;
  }
  await rollback();
}

async function diskMatches(backup, updated) {
  if (isPackage(backup)) {
    return verifyPackageDisk(backup, updated).then(() => true, () => false);
  }
  const file = await validateDirectory(backup.directory, backup);
  return await sha256(await readBytes(file)) === (updated ? backup.targetHash : backup.beforeHash);
}

async function rollback({ manual = false } = {}) {
  if (!recovery) return;
  const current = await rpc("info").catch((error) => {
    if (manual && error.name === "ConnectionError") return null;
    throw error;
  });
  const restore = isPackage(recovery) ? restorePackage : restoreRecovery;
  if (!current) {
    await restore(recovery);
    await save(key("recovery"), null);
    recovery = null;
    say("旧版に戻しました。chrome://extensions で拡張機能を再読み込みしてください。");
    return;
  }
  if (!current.transfer && current.receipt?.status === "executed" && current.receipt.sha256 === recovery.targetHash) {
    await confirmReload(recovery);
    return;
  }
  if (current.transfer && current.transfer.token !== recovery.token) {
    throw namedError("RecoveryError", "他の更新が進行中のため復元できません。");
  }
  await restore(recovery);
  await rpc("cancel", { token: recovery.token, pause: manual });
  if (!manual) await rpc("unblock");
  await save(key("recovery"), null);
  recovery = null;
  say(manual ? "中断前のコードに戻し、自動更新を停止しました。" : "中断前のコードに戻しました。");
}

async function apply(plan) {
  const before = await rpc("info");
  const token = crypto.randomUUID();
  const trace = { visibility: document.visibilityState, userActivation: navigator.userActivation.isActive, permission };
  Object.assign(document.documentElement.dataset, { updateVisibility: trace.visibility, updateActivation: String(trace.userActivation), beforePermission: permission, beforeBootId: before.bootId });
  say("v" + plan.version + " を適用しています…");
  const onBackup = async (backup) => {
    const saved = { ...backup, token, bootId: before.bootId };
    await save(key("recovery"), saved);
    recovery = saved;
    await rpc("begin", { token, beforeHash: backup.beforeHash, targetHash: backup.targetHash });
  };
  try {
    if (isPackage(plan)) {
      const files = Object.fromEntries(Object.entries(plan.files).map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
      await replacePackage(directory, plan.bundle, files, {
        targetHash: plan.sha256, onBackup, readMarker: () => rpc("package-marker"),
      });
    } else {
      const code = Uint8Array.from(plan.code);
      if (await sha256(code) !== plan.sha256) throw namedError("IntegrityError", "受け取ったコードのハッシュが一致しません。");
      await replaceActive(directory, plan.bundle, code, { onBackup, readPackaged: () => rpc("hash") });
    }
  } catch (error) {
    // The worker may have accepted begin even if its response was lost.
    if (recovery && error.rollback !== "failed") {
      try { await rollback(); }
      catch { await rpc("attention", { cause: "recovery" }); throw error; }
    }
    if (error.rollback === "failed") await rpc("attention", { cause: "recovery" });
    else if (error.name === "NotAllowedError") {
      const currentPermission = await directory.queryPermission({ mode: "readwrite" });
      if (currentPermission === "granted") await rpc("attention", { cause: "folder" });
      else await rpc("permission", { permission: currentPermission });
    }
    if (["FolderValidationError", "SourceMismatchError", "NotFoundError"].includes(error.name)) {
      await rpc("attention", { cause: "folder" });
    }
    throw error;
  }
  // After commit, keep the backup until a fresh worker confirms execution.
  await rpc("commit", { token });
  await confirmReload(recovery);
}

async function sync() {
  await refresh();
  await rpc("permission", { permission });
  if (permission !== "granted") {
    say(recovery || state.transfer ? "中断した更新を確認するためフォルダの再許可が必要です。" :
      directory ? "保存したフォルダを再許可してください。" : "Chrome に読み込んだ拡張機能のフォルダを選んでください。");
    return;
  }
  if (recovery || state.transfer) {
    try { await completeTransfer(); }
    catch (error) { await rpc("attention", { cause: "recovery" }); throw error; }
    return;
  }
  const plan = await rpc("plan");
  if (!plan) {
    say(state.status?.phase === "folder-required" ? "Chrome に読み込んだフォルダを選び直してください。" :
      state.status?.phase === "package-unavailable" ? "最新リリースに全体更新用のパッケージがありません。" :
      state.enabled ? "自動更新は有効です。このタブは閉じられます。" : "フォルダを登録しました。自動更新を有効にできます。");
    return;
  }
  await apply(plan);
}

$("#pick").onclick = () => action(async () => {
  const chosen = await window.showDirectoryPicker({ id: "github-auto-update-lab", mode: "readwrite" });
  await locked(async () => {
    await refresh();
    if (recovery || state.transfer) throw namedError("RecoveryError", "先に中断した更新を確認してください。");
    const bundle = await rpc("snapshot");
    if (isPackage(bundle)) await validatePackageDirectory(chosen, bundle);
    else if (await sha256(await readBytes(await validateDirectory(chosen, bundle))) !== bundle.sha256) {
      throw namedError("SourceMismatchError", "選択したフォルダの active.js が実行中のものと一致しません。");
    }
    await save(key("directory"), chosen);
    await rpc("unblock");
    await sync();
  });
});
$("#grant").onclick = () => action(async () => {
  if (await directory.requestPermission({ mode: "readwrite" }) !== "granted") throw namedError("NotAllowedError", "書き込みが許可されませんでした。");
  await locked(sync);
});
$("#enable").onclick = () => action(() => locked(async () => {
  await rpc("permission", { permission: await directory.queryPermission({ mode: "readwrite" }) });
  await rpc("enable");
  say("自動更新を有効にしました。このタブは閉じられます。");
}));
$("#restore").onclick = () => action(async () => {
  if (await recovery.directory.requestPermission({ mode: "readwrite" }) !== "granted") throw namedError("NotAllowedError", "復元にも書き込み許可が必要です。");
  await locked(() => rollback({ manual: true }));
});
if (idOK) await action(() => locked(sync));
else say("Chrome の拡張機能メニューから「HTTPS 更新ページを開く」を選んでください。");
