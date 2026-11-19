import { record } from "./store.js";

const $ = (selector) => document.querySelector(selector);
const labels = {
  ready: "フォルダを登録すると自動更新を開始できます。",
  monitoring: "GitHub Releases を定期確認しています。",
  "up-to-date": "新しいリリースはありません。",
  "package-unavailable": "最新リリースに全体更新用の署名済みパッケージがありません。",
  downloaded: "検証済みの更新があります。適用するには自動更新を有効にしてください。",
  "awaiting-updater": "HTTPS 更新ページでの処理を待っています。",
  "permission-required": "更新ページでフォルダを登録するか、書き込みを再許可してください。",
  "folder-required": "更新ページで正しい拡張機能フォルダを選び直してください。",
  "recovery-required": "更新ページで中断した更新を確認してください。",
  reloading: "書き込みを確認しました。拡張機能を再読み込みしています。",
  updated: "新しいコードの起動を確認しました。",
  restored: "前のコードを確認しました。",
  disabled: "自動更新を停止しました。",
};
let busy = false;

async function send(kind) {
  const result = await chrome.runtime.sendMessage({ kind });
  if (result?.error) throw new Error(result.error.message);
  return result;
}

async function refresh() {
  const state = await send("status");
  $("#manifest-version").textContent = state.manifestVersion;
  $("#enabled").textContent = state.enabled ? "有効" : "停止中";
  $("#interval").textContent = state.alarm?.periodInMinutes ? (state.alarm.periodInMinutes * 60) + " 秒" : "停止中";
  $("#pending").textContent = state.pending ?? state.transfer?.targetVersion ?? "なし";
  $("#permission").textContent = { granted: "前回の確認: 許可あり", prompt: "再許可が必要", denied: "拒否", "not-selected": "未登録" }[state.permission] ?? "確認中";
  $("#disable").disabled = busy || !state.enabled;
  $("#check").disabled = busy;
  $("#updater").disabled = busy;
  $("#status").textContent = state.status?.phase === "error" ? state.status.message : labels[state.status?.phase] ?? "";
  $("#events").textContent = state.events.map((event) => JSON.stringify(event)).join("\n");
}

function showError(error) { $("#status").textContent = error.message; }
for (const kind of ["updater", "disable", "check"]) {
  $("#" + kind).onclick = async () => {
    if (busy) return;
    busy = true;
    for (const button of document.querySelectorAll("button")) button.disabled = true;
    try { await send(kind); busy = false; await refresh(); }
    catch (error) { showError(error); }
    finally { busy = false; }
  };
}

try {
  const active = await import("./active.js");
  $("#version").textContent = active.version;
  const proof = active.runSource($("#demo"));
  await record({ phase: "ui-executed", version: active.version, source: active.sourceId, proof });
} catch (error) { $("#demo h2").textContent = "active.js の実行失敗: " + error.message; }
await refresh().catch(showError);
setInterval(() => { if (!busy) void refresh().catch(showError); }, 2000);
