import { equalBytes, replaceActive, restoreRecovery, sha256, validateDirectory } from "./core.js";
import { load, save } from "./store.js";
import { PROTOCOL, UPDATER_URL } from "./policy.js";

const $ = (selector) => document.querySelector(selector);
const hot = location.protocol === "chrome-extension:";
const targetId = hot ? chrome.runtime.id : new URL(location.href).searchParams.get("id");
const documentId = crypto.randomUUID();
const report = { mode: hot ? "hot-module" : "external-https", documentId, origin: location.origin, startedAt: new Date().toISOString(), events: [] };
let directory, recovery, currentModule, running = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(event) {
  report.events.push({ at: new Date().toISOString(), ...event });
  $("#report").textContent = JSON.stringify(report, null, 2);
  localStorage.setItem(`isolation-report-${report.mode}`, JSON.stringify(report));
}

async function rpc(action, data = {}) {
  if (!globalThis.chrome?.runtime?.sendMessage || !/^[a-p]{32}$/.test(targetId ?? "")) throw new Error("対象拡張機能に接続できません。対象を読み込んでからこのページを開き直してください。");
  const message = { protocol: PROTOCOL, action, ...data };
  const response = hot ? await chrome.runtime.sendMessage(message) : await chrome.runtime.sendMessage(targetId, message);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function snapshot() {
  const data = await rpc("snapshot");
  return { ...data, bundle: { files: Object.fromEntries(Object.entries(data.files).map(([name, values]) => [name, new Uint8Array(values)])), active: new Uint8Array(data.active) } };
}

async function permission() {
  const result = directory ? await directory.queryPermission({ mode: "readwrite" }) : "not-selected";
  $("#permission").textContent = result;
  return result;
}

async function controls() {
  $("#pick").disabled = running || Boolean(recovery);
  $("#grant").disabled = running || !directory;
  $("#run").disabled = running || !directory || Boolean(recovery);
  $("#restore").hidden = !recovery;
  $("#restore").disabled = running;
  await permission();
}

async function action(task) {
  if (running) return;
  running = true;
  for (const button of document.querySelectorAll("button:not(#web)")) button.disabled = true;
  try { await task(); }
  catch (error) { log({ phase: "error", name: error.name, message: error.message, rollback: error.rollback }); $("#status").textContent = `${error.name}: ${error.message}`; }
  finally { running = false; await controls(); }
}

async function confirmReload(version, previousBootId) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const state = await rpc("info");
      if (state.compiledVersion === version && state.bootId !== previousBootId) return state;
    } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw new Error(`対象の再起動を確認できません: ${lastError?.message ?? version}`);
}

async function update(version) {
  const state = await snapshot();
  const bytes = state.bundle.files[`variants/${version}.js`];
  if (!bytes) throw new Error("未登録の検証用ソースです。");
  const beforePermission = await permission();
  if (beforePermission !== "granted") throw new Error("書き込み許可が有効ではありません。");
  const beforeHash = await sha256(state.bundle.active);
  const previousModule = currentModule;
  let afterInfo;
  try {
    await replaceActive(directory, state.bundle, bytes, {
      onBackup: async (backup) => { recovery = backup; await save("recovery", backup); },
      readPackaged: async () => (await snapshot()).bundle.active,
      onVerified: async () => {
        if (hot) {
          const module = await import(chrome.runtime.getURL(`active.js?hot=${crypto.randomUUID()}`));
          if (module.version !== version) throw new Error("新しいモジュールの版が一致しません。");
          const proof = module.runSource($("#demo"));
          currentModule = module;
          afterInfo = await rpc("info");
          if (afterInfo.bootId !== state.bootId) throw new Error("固定の更新処理が再起動しました。");
          log({ phase: "new-module-executed", version: module.version, source: module.sourceId, proof });
        } else {
          await rpc("reload", { version });
          afterInfo = await confirmReload(version, state.bootId);
          $("#demo h2").textContent = `対象拡張機能: v${afterInfo.compiledVersion}`;
          $("#demo p").textContent = "新しいサービスワーカーの起動を確認";
        }
      },
    });
  } catch (error) {
    if (error.rollback !== "failed") { recovery = null; await save("recovery", null); }
    if (hot && previousModule) { currentModule = previousModule; previousModule.runSource($("#demo")); }
    throw error;
  }
  recovery = null;
  await save("recovery", null);
  const afterPermission = await permission();
  $("#boot").textContent = afterInfo.bootId;
  log({ phase: "updated", version, beforePermission, afterPermission, userActivation: navigator.userActivation.isActive, documentId, beforeBootId: state.bootId, afterBootId: afterInfo.bootId, compiledVersion: afterInfo.compiledVersion, beforeHash, afterHash: await sha256(bytes) });
  if (afterPermission !== "granted") throw new Error("更新後に書き込み許可が失われました。");
}

$("#pick").onclick = () => action(async () => {
  const picked = await window.showDirectoryPicker({ id: "permission-isolation", mode: "readwrite" });
  await validateDirectory(picked, (await snapshot()).bundle);
  await save("directory", picked);
  directory = picked;
  log({ phase: "folder-registered", permission: await permission() });
  $("#status").textContent = "登録しました。自動更新の開始ボタンを押せます。";
});
$("#grant").onclick = () => action(async () => {
  const result = await directory.requestPermission({ mode: "readwrite" });
  log({ phase: "requestPermission", result });
  $("#status").textContent = `再許可: ${result}`;
});
$("#run").onclick = () => action(async () => {
  const versions = hot ? ["0.2.1", "0.2.2"] : ["0.2.3", "0.2.4"];
  log({ phase: "sequence-started", versions });
  for (const version of versions) { $("#status").textContent = `6秒後に ${version} へ更新します…`; await sleep(6000); await update(version); }
  log({ phase: "sequence-complete", permission: await permission() });
  $("#status").textContent = "2回の更新と、更新後の権限を確認しました。";
});
$("#web").onclick = () => chrome.tabs.create({ url: `${UPDATER_URL}?id=${targetId}` });
$("#restore").onclick = () => action(async () => {
  if (await recovery.directory.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("復元の許可が必要です。");
  await restoreRecovery(recovery, (await snapshot()).bundle);
  recovery = null;
  await save("recovery", null);
  log({ phase: "recovered" });
  $("#status").textContent = "バックアップを復元しました。";
});

async function start() {
  $("#mode").textContent = report.mode;
  $("#document").textContent = documentId;
  $("#web").hidden = !hot;
  directory = await load("directory");
  recovery = await load("recovery");
  const initialPermission = await permission();
  log({ phase: "page-started", restoredHandle: Boolean(directory), permission: initialPermission });
  try {
    const state = await rpc("info");
    $("#boot").textContent = state.bootId;
    if (hot) { currentModule = await import("./active.js"); currentModule.runSource($("#demo")); }
    else { $("#demo h2").textContent = `対象拡張機能: v${state.compiledVersion}`; $("#demo p").textContent = "HTTPS の独立した更新ページ"; }
    $("#status").textContent = "接続しました。フォルダを登録してください。";
    log({ phase: "connected", ...state });
  } catch (error) { $("#status").textContent = error.message; log({ phase: "connection-error", message: error.message }); }
  await controls();
}
void start().catch((error) => { $("#status").textContent = `${error.name}: ${error.message}`; });
