import { loadBundle, restoreRecovery, validateDirectory } from "./core.js";
import { load, readEvents, record, save } from "./store.js";

const $ = (selector) => document.querySelector(selector);
let directory, recovery;
let busy = false, ready = false, localError = "";
if (new URL(location.href).searchParams.has("tab")) document.body.classList.add("tab");

async function send(kind) {
  const result = await chrome.runtime.sendMessage({ kind });
  if (result?.error) throw Object.assign(new Error(result.error.message), { name: result.error.name });
  return result;
}

async function refresh() {
  directory = await load("directory");
  recovery = await load("recovery");
  let permission = "未選択";
  try { if (directory) permission = await directory.queryPermission({ mode: "readwrite" }); }
  catch (error) { permission = error.name; }
  $("#permission").textContent = permission;
  $("#grant").disabled = busy || !directory;
  $("#enable").disabled = busy || !directory || Boolean(recovery);
  $("#register").disabled = busy || Boolean(recovery);
  $("#recover").hidden = !recovery;
  $("#recover").disabled = busy;
  $("#check").disabled = busy;
  $("#disable").disabled = busy;
  try {
    const state = await send("status");
    $("#enabled").textContent = state.enabled ? "有効" : "停止中";
    $("#interval").textContent = state.alarm?.periodInMinutes ? `${state.alarm.periodInMinutes * 60} 秒` : "停止中";
    $("#pending").textContent = state.pending ?? "なし";
    if (!busy) $("#status").textContent = localError || JSON.stringify(state.status ?? { phase: "ready" }, null, 2);
    $("#events").textContent = state.events.map((event) => JSON.stringify(event)).join("\n");
  } catch (error) {
    $("#status").textContent = localError || `${error.name}: ${error.message}\nバックアップがあれば復元できます。`;
    $("#events").textContent = (await readEvents()).slice(-50).map((event) => JSON.stringify(event)).join("\n");
  }
}

async function action(task) {
  if (busy || !ready) return;
  busy = true;
  localError = "";
  for (const button of document.querySelectorAll("button:not(#tab)")) button.disabled = true;
  try { await task(); }
  catch (error) {
    localError = `${error.name}: ${error.message}`;
    await record({ phase: "ui-error", name: error.name, message: error.message }).catch(() => {});
  } finally { busy = false; await refresh(); }
}

$("#register").onclick = () => action(async () => {
  const selection = window.showDirectoryPicker({ id: "github-auto-update-lab", mode: "readwrite" });
  const selected = await selection;
  await navigator.locks.request("github-unpacked-self-update-lab", async () => {
    if (await load("recovery")) throw new Error("先にバックアップを復元してください。");
    await validateDirectory(selected, await loadBundle());
    await save("directory", selected);
    await record({ phase: "folder-registered", permission: await selected.queryPermission({ mode: "readwrite" }) });
  });
});

$("#grant").onclick = () => action(async () => {
  const permission = await directory.requestPermission({ mode: "readwrite" });
  await record({ phase: "permission-click", permission });
  if (permission !== "granted") throw new Error(`再許可の結果: ${permission}`);
  await send("apply");
});
$("#enable").onclick = () => action(() => send("enable"));
$("#disable").onclick = () => action(() => send("disable"));
$("#check").onclick = () => action(() => send("check"));
$("#tab").onclick = () => chrome.tabs.create({ url: `${chrome.runtime.getURL("popup.html")}?tab=1` });
$("#recover").onclick = () => action(async () => {
  const backup = recovery;
  if (!backup || await backup.directory.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("バックアップ元の再許可が必要です。");
  await navigator.locks.request("github-unpacked-self-update-lab", async () => {
    await restoreRecovery(backup, await loadBundle());
    await save("receipt", backup.previousReceipt);
    await save("recovery", null);
    await record({ phase: "recovered", version: backup.fromVersion });
    chrome.runtime.reload();
  });
});

async function start() {
  try {
    const active = await import("./active.js");
    $("#version").textContent = active.version;
    const proof = active.runSource($("#demo"));
    await record({ phase: "ui-executed", version: active.version, source: active.sourceId, proof });
  } catch (error) { localError = `active.js の実行失敗: ${error.name}: ${error.message}`; }
  ready = true;
  await refresh();
  setInterval(() => { if (!busy) void refresh().catch(() => {}); }, 2000);
}
void start().catch((error) => { $("#status").textContent = `${error.name}: ${error.message}`; });
