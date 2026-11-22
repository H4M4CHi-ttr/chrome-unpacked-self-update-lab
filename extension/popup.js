import { CHECK_ALARM, LOCK, PRIVATE_REPOSITORY, RELEASE_TOKEN_KEY, REPOSITORY } from "./config.js";
import { readOwnPackage, restorePackage, validatePackageDirectory } from "./package.js";
import { load, record, saveAll } from "./store.js";

const $ = (selector) => document.querySelector(selector);
const labels = {
  monitoring: "Chrome の起動中は新しいリリースを定期的に確認します。",
  "up-to-date": "新しいリリースはありません。",
  "package-unavailable": "最新リリースに全体更新用の署名済みパッケージがありません。",
  downloaded: "検証済みの更新があります。「取得済みの更新を適用」で更新できます。",
  "permission-required": "更新を保留しました。",
  reloading: "書き込みを確認しました。拡張機能を再読み込みしています。",
  updated: "新しいコードの起動を確認しました。",
  restored: "旧版を復元し、自動更新を停止しました。",
  disabled: "自動更新を停止しました。",
};
let busy = false, localError = "", directory, backup;
const controls = ["pick", "grant", "enable", "forget", "restore", "check", "disable", "apply"];
const fullPage = Boolean(await chrome.tabs.getCurrent());
document.body.classList.toggle("tab", fullPage);
$("#folder-settings").hidden = !fullPage;
$("#version-details").open = !fullPage;
const updater = $("#updater");
updater.hidden = fullPage;
updater.onclick = () => { void chrome.runtime.openOptionsPage().catch(showError); };

async function send(kind) {
  const result = await chrome.runtime.sendMessage({ kind });
  if (result?.error) throw Object.assign(new Error(result.error.message), { name: result.error.name });
  return result;
}

function showError(error) {
  localError = error.name + ": " + error.message;
  $("#status").textContent = localError;
}

async function refresh() {
  [directory, backup] = await Promise.all([load("directory"), load("recovery")]);
  const perm = directory ? await directory.queryPermission({ mode: "readwrite" }) : "not-selected";
  const state = await send("status");
  const needsFolder = !directory || state.status?.phase === "folder-required";
  const needsGrant = !needsFolder && perm !== "granted";
  let guide = "";
  if (backup) guide = "中断した更新を、設定画面で旧版に戻してください。";
  else if (needsFolder) {
    guide = "Chrome に読み込んだときと同じフォルダを選び、読み書きを許可してください。";
    if (state.enableOnFirstGrant) {
      guide += "\n登録すると自動更新がオンになります。後で再許可が必要になると「更新設定」が開きます。Chrome に「サイトアクセス時は常に許可」が表示されたら選んでください。";
    }
  } else if (needsGrant) {
    guide = state.enabled ? "自動更新はフォルダの再許可を待っています。" : "保存したフォルダへの書き込みを許可してください。";
    guide += "\nChrome の確認画面に「サイトアクセス時は常に許可」が表示されたら選んでください。登録済みのフォルダをそのまま使えます。";
  }
  $("#folder-guide").textContent = guide;
  updater.textContent = needsGrant && !backup ? "再許可画面を開く" : "更新設定を開く";
  updater.classList.toggle("primary", Boolean(guide));

  const permissionText = { granted: "許可あり", prompt: "再許可が必要", denied: "拒否", "not-selected": "未登録" };
  $("#permission").textContent = (permissionText[perm] ?? perm) + (directory ? "（" + directory.name + "）" : "");
  $("#pick").textContent = directory ? "フォルダを選び直す" : "拡張機能フォルダを選ぶ";
  $("#pick").classList.toggle("primary", needsFolder);
  $("#pick").hidden = Boolean(backup);
  $("#pick").disabled = busy || Boolean(backup);
  $("#grant").hidden = !needsGrant || Boolean(backup);
  $("#grant").disabled = busy || !needsGrant || Boolean(backup);
  $("#forget").hidden = !directory || Boolean(backup);
  $("#forget").disabled = busy || !directory || Boolean(backup);
  $("#restore").hidden = !backup;
  $("#restore").disabled = busy || !backup;

  let enabledLabel = state.enableOnFirstGrant ? "未設定" : "オフ";
  if (state.enabled) {
    enabledLabel = "オン";
    if (needsFolder) enabledLabel = "フォルダの確認待ち";
    else if (needsGrant) enabledLabel = "再許可待ち";
  }
  $("#enabled").textContent = backup ? "復元待ち" : enabledLabel;
  $("#manifest-version").textContent = state.manifestVersion;
  $("#interval").textContent = state.alarm?.periodInMinutes ? state.alarm.periodInMinutes + " 分" : "停止中";
  $("#pending").textContent = state.pending ?? "なし";
  $("#enable").hidden = !directory || state.enabled || Boolean(backup);
  $("#enable").disabled = busy || needsFolder || needsGrant || Boolean(backup) || state.enabled;
  $("#disable").hidden = !state.enabled;
  $("#disable").disabled = busy || !state.enabled;
  $("#check").disabled = busy || Boolean(backup);
  $("#apply").hidden = !state.pending;
  $("#apply").disabled = busy || !state.pending || needsFolder || needsGrant || Boolean(backup);

  const detail = state.status?.message;
  const label = labels[state.status?.phase] ?? "";
  const message = localError || [label, detail].filter(Boolean).join("\n");
  if ($("#status").textContent !== message) $("#status").textContent = message;
  $("#events").textContent = state.events.map((event) => JSON.stringify(event)).join("\n");
}

function action(id, task) {
  const button = $("#" + id);
  button.onclick = async () => {
    if (busy) return;
    const wasFocused = document.activeElement === button;
    busy = true;
    localError = "";
    for (const control of controls) $("#" + control).disabled = true;
    try { await task(); }
    catch (error) { showError(error); }
    finally {
      busy = false;
      await refresh().catch(showError);
      if (wasFocused && document.activeElement === document.body) {
        (button.hidden || button.disabled ? $("#settings-title") : button).focus();
      }
    }
  };
}

action("pick", async () => {
  const chosen = await window.showDirectoryPicker({ id: "github-auto-update-lab", mode: "readwrite" });
  await navigator.locks.request(LOCK, async () => {
    if (await load("recovery")) throw new Error("フォルダを変更する前に中断した更新を復元してください。");
    await validatePackageDirectory(chosen, await readOwnPackage());
    await saveAll({ directory: chosen, blocked: null });
  });
  await send("folder-ready");
});
action("grant", async () => {
  if (!directory || await directory.requestPermission({ mode: "readwrite" }) !== "granted") {
    throw new Error("書き込みは許可されませんでした。「保存したフォルダを再許可」からやり直せます。");
  }
  await send("folder-ready");
});
action("forget", async () => {
  await navigator.locks.request(LOCK, async () => {
    if (await load("recovery")) throw new Error("登録を解除する前に中断した更新を復元してください。");
    await saveAll({ directory: null, pending: null, enabled: false, blocked: null });
    await chrome.alarms.clear(CHECK_ALARM);
  });
  await send("folder-ready");
});
action("restore", async () => {
  const selected = backup;
  if (!selected || await selected.directory.requestPermission({ mode: "readwrite" }) !== "granted") {
    throw new Error("復元には、元のフォルダの書き込み許可が必要です。");
  }
  // Recovery must also work from this page if the updated worker cannot start.
  await navigator.locks.request(LOCK, async () => {
    const latest = await load("recovery");
    if (!latest || latest.id !== selected.id) throw new Error("更新記録が変わりました。状態を確認してください。");
    await restorePackage(latest);
    await saveAll({ receipt: latest.previousReceipt ?? null, recovery: null, pending: null, enabled: false,
      blocked: null, status: { phase: "restored", at: new Date().toISOString() } });
    await chrome.alarms.clear(CHECK_ALARM);
    await record({ phase: "restored", version: latest.fromVersion });
    await chrome.action.setBadgeText({ text: "" });
    chrome.runtime.reload();
  });
});
for (const kind of ["check", "enable", "disable", "apply"]) action(kind, () => send(kind));

if (PRIVATE_REPOSITORY) {
  const controls = $("#release-token-controls");
  const field = $("#release-token");
  const remove = $("#delete-release-token");
  const state = $("#release-token-state");
  const link = $("#create-release-token");
  const url = new URL(link.href);
  url.searchParams.set("target_name", REPOSITORY.split("/")[0]);
  link.href = url;
  $("#release-access").open = true;
  $("#release-token-help").textContent = "プライベートリポジトリの更新にのみ必要です。対象は " + REPOSITORY + " です。";
  state.hidden = false;

  function showTokenState(registered) {
    remove.disabled = !registered;
    state.textContent = registered ? "登録済み。確認するには「今すぐ確認」を押してください。" : "未登録";
  }

  async function saveToken(token) {
    controls.disabled = true;
    try {
      await navigator.locks.request(LOCK, () => saveAll({ [RELEASE_TOKEN_KEY]: token, retryAt: null, pending: null }));
      field.value = "";
      showTokenState(Boolean(token));
    } catch {
      state.textContent = "トークンの設定を保存できませんでした。";
    } finally {
      controls.disabled = false;
    }
  }

  $("#release-token-form").onsubmit = (event) => {
    event.preventDefault();
    const value = field.value.trim();
    if (!/^[\x21-\x7e]+$/.test(value)) {
      state.textContent = "発行したトークンを1行で入力してください。";
      return;
    }
    void saveToken(value);
  };
  remove.onclick = () => { void saveToken(null); };
  try {
    showTokenState(Boolean(await load(RELEASE_TOKEN_KEY)));
    controls.disabled = false;
  } catch {
    state.textContent = "トークンの設定を読み込めませんでした。";
  }
}

try {
  const active = await import("./active.js");
  $("#version").textContent = active.version;
  const proof = active.runSource($("#demo"));
  await record({ phase: "ui-executed", version: active.version, source: active.sourceId, proof });
} catch (error) { $("#demo h2").textContent = "active.js の実行失敗: " + error.message; }
await refresh().catch(showError);
setInterval(() => { if (!busy) void refresh().catch(showError); }, 2000);
