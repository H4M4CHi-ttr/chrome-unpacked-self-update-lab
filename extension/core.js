export const IMMUTABLE_FILES = [
  "manifest.json", "poc-identity.json", "popup.html", "popup.css", "popup.js",
  "worker.js", "core.js", "store.js", "release.js", "config.js", "trust.json", "install.json", "vendor/fflate.js",
];

export function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

export const equalBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
export const readBytes = async (file) => new Uint8Array(await (await file.getFile()).arrayBuffer());
export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function readOwn(filename) {
  const url = new URL(chrome.runtime.getURL(filename));
  url.searchParams.set("read", crypto.randomUUID());
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${filename}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadBundle() {
  return { files: Object.fromEntries(await Promise.all(IMMUTABLE_FILES.map(async (name) => [name, await readOwn(name)]))), active: await readOwn("active.js") };
}

export async function validateDirectory(directory, bundle) {
  if (await directory.queryPermission({ mode: "readwrite" }) !== "granted") {
    throw namedError("NotAllowedError", "フォルダの再許可が必要です。");
  }
  for (const name of IMMUTABLE_FILES) {
    const parts = name.split("/");
    let folder = directory;
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
    let file;
    try { file = await folder.getFileHandle(parts.at(-1)); }
    catch (error) { throw namedError(error.name, `必要なファイルを取得できません: ${name}`); }
    if (!equalBytes(await readBytes(file), bundle.files[name])) throw namedError("FolderValidationError", `${name} が実行中の拡張機能と一致しません。`);
  }
  return directory.getFileHandle("active.js");
}

async function writeExact(file, bytes) {
  const stream = await file.createWritable({ keepExistingData: false });
  try { await stream.write(bytes); await stream.close(); }
  catch (error) { try { await stream.abort(); } catch {} throw error; }
  if (!equalBytes(await readBytes(file), bytes)) throw namedError("VerificationError", "active.js の書き込み後の内容が一致しません。");
}

export async function replaceActive(directory, bundle, after, { onBackup = async () => {}, onVerified = async () => {}, readPackaged = () => readOwn("active.js") } = {}) {
  const file = await validateDirectory(directory, bundle);
  const before = await readBytes(file);
  if (!equalBytes(before, bundle.active)) throw namedError("SourceMismatchError", "選択先の active.js が実行中のものと一致しません。");
  await onBackup({ directory, before, beforeHash: await sha256(before), targetHash: await sha256(after) });
  let attempted = false;
  try {
    if (!equalBytes(await readBytes(file), before)) throw namedError("SourceMismatchError", "更新直前に active.js が変更されました。");
    attempted = true;
    await writeExact(file, after);
    if (!equalBytes(await readPackaged(), after)) throw namedError("FolderValidationError", "選択先への変更が Chrome の読み込み元に反映されません。別のコピーを選んでいないか確認してください。");
    await onVerified();
  } catch (cause) {
    let rollback = "not-needed", rollbackError;
    if (attempted) {
      try { await writeExact(file, before); rollback = "restored"; }
      catch (error) { rollback = "failed"; rollbackError = { name: error.name, message: error.message }; }
    }
    throw Object.assign(namedError(cause.name, cause.message), { rollback, rollbackError });
  }
}

export async function restoreRecovery(recovery, bundle) {
  const file = await validateDirectory(recovery.directory, bundle);
  await writeExact(file, recovery.before);
}
