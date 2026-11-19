import { isHash } from "./bridge.js";
import { equalBytes, namedError, readOwn, sha256, writeExact } from "./core.js";

export const PACKAGE_FORMAT = 2;
export const PACKAGE_ZIP = "auto-update-https.zip";
export const PACKAGE_METADATA = "package-update.json";
export const PACKAGE_SIGNATURE = "package-update.sig";
export const PACKAGE_LIMIT = 2 * 1024 * 1024;
export const PACKAGE_INDEX = "install.json";

const required = ["manifest.json", "active.js", PACKAGE_INDEX, "poc-identity.json", "trust.json"];
const encoder = new TextEncoder();
export const decodeJSON = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const packageError = (message) => namedError("PackageError", message);

function validatePaths(paths) {
  const spelling = new Map(), leaves = new Set(paths.map((path) => path.toLowerCase()));
  if (!paths.length || paths.length > 96 || leaves.size !== paths.length) throw packageError("パッケージのファイル数またはパスの重複が不正です。");
  for (const path of paths) {
    const parts = path.split("/");
    if (path.length > 180 || parts.some((part) => !/^[a-z0-9_][a-z0-9._-]*$/i.test(part) ||
        Object.hasOwn(Object.prototype, part) || part.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw packageError("パッケージに使用できないパスがあります: " + path);
    }
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const folded = prefix.toLowerCase();
      if ((spelling.has(folded) && spelling.get(folded) !== prefix) || (i < parts.length && leaves.has(folded))) {
        throw packageError("ファイルとフォルダのパスが衝突しています: " + path);
      }
      spelling.set(folded, prefix);
    }
  }
}

export function validateInventory(files) {
  if (!files || typeof files !== "object" || Array.isArray(files) ||
      !required.every((path) => Object.hasOwn(files, path))) throw packageError("配信ファイル一覧に必要な項目がありません。");
  validatePaths(Object.keys(files));
  if (!Object.values(files).every(isHash)) throw packageError("配信ファイル一覧に不正なハッシュがあります。");
}

export async function hashInventory(files) {
  validateInventory(files);
  return sha256(encoder.encode(JSON.stringify(Object.keys(files).sort().map((path) => [path, files[path]]))));
}

export async function hashFiles(files) {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, bytes]) => [path, await sha256(bytes)])));
}

export function validatePackageVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(version) ||
      version === "0.0.0" || version.split(".").some((part) => Number(part) > 65535)) {
    throw packageError("Chrome 拡張機能の版番号が不正です。");
  }
}

export async function packageInventory(bytes) {
  const index = decodeJSON(bytes);
  if (index?.format !== PACKAGE_FORMAT || !index.files || typeof index.files !== "object" ||
      Array.isArray(index.files) || Object.hasOwn(index.files, PACKAGE_INDEX)) {
    throw packageError("全体更新に対応したインストール記録が必要です。");
  }
  validatePackageVersion(index.version);
  const files = { ...index.files, [PACKAGE_INDEX]: await sha256(bytes) };
  const sha256sum = await hashInventory(files);
  if (index.sha256 !== files["active.js"]) throw packageError("インストール記録にある active.js のハッシュが一致しません。");
  return { format: PACKAGE_FORMAT, version: index.version, files, sha256: sha256sum };
}

export function assertManifestVersion(bytes, version) {
  validatePackageVersion(version);
  const manifest = decodeJSON(bytes);
  if (manifest?.manifest_version !== 3 || manifest.version !== version) {
    throw packageError("manifest.json のバージョンが配信情報と一致しません。");
  }
  if (Object.hasOwn(manifest, "version_name") && manifest.version_name !== version) {
    throw packageError("manifest.json の表示用バージョンが配信情報と一致しません。");
  }
  return manifest;
}

export function assertCompatibleManifest(before, target, version) {
  const next = assertManifestVersion(target, version);
  const mutable = new Set(["version", "version_name", "name", "short_name", "description", "icons"]);
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (!mutable.has(key) && JSON.stringify(before[key]) !== JSON.stringify(next[key])) {
      throw packageError("manifest.json の " + key + " を変更するには、新しい ZIP から読み込み直してください。");
    }
  }
}

export async function readOwnPackage() {
  const bundle = await packageInventory(await readOwn(PACKAGE_INDEX, 32 * 1024));
  for (const [path, expected] of Object.entries(bundle.files)) {
    const bytes = await readOwn(path, PACKAGE_LIMIT);
    if (await sha256(bytes) !== expected) {
      throw namedError("SourceMismatchError", path + " がインストール記録と一致しません。");
    }
  }
  return bundle;
}

async function locate(directory, path, create = false) {
  const parts = path.split("/");
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name: parts.at(-1) };
}

async function diskFile(directory, path) {
  try {
    const parent = await locate(directory, path);
    const entry = await parent.directory.getFileHandle(parent.name);
    const file = await entry.getFile();
    if (file.size > PACKAGE_LIMIT) throw packageError("ローカルファイルがサイズ上限を超えています: " + path);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { parent, entry, bytes, hash: await sha256(bytes) };
  } catch (error) {
    if (error.name === "NotFoundError") return null;
    throw error;
  }
}

const pathsFor = (before, after) => {
  validateInventory(before);
  validateInventory(after);
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  validatePaths(paths);
  return paths;
};

async function inspectDirectory(directory, expected, other = expected) {
  if (await directory.queryPermission({ mode: "readwrite" }) !== "granted") {
    throw namedError("NotAllowedError", "フォルダの再許可が必要です。");
  }
  const entries = {};
  let size = 0;
  for (const path of pathsFor(expected, other)) {
    const file = await diskFile(directory, path);
    if (file?.hash !== expected[path]) {
      throw namedError("SourceMismatchError", path + " が拡張機能の記録と一致しません。");
    }
    if (!file) continue;
    size += file.bytes.length;
    if (size > PACKAGE_LIMIT) throw packageError("ローカルパッケージがサイズ上限を超えています。");
    entries[path] = file.bytes;
  }
  return entries;
}

export const validatePackageDirectory = (directory, bundle) => inspectDirectory(directory, bundle.files);

async function changeFile(directory, path, expected, bytes) {
  const current = await diskFile(directory, path);
  if (current?.hash !== expected) throw namedError("SourceMismatchError", path + " は直前に変更されました。");
  if (current && bytes && equalBytes(current.bytes, bytes)) return;
  if (!bytes) {
    if (current) await current.parent.directory.removeEntry(current.parent.name);
    return;
  }
  const parent = current?.parent ?? await locate(directory, path, true);
  const entry = current?.entry ?? await parent.directory.getFileHandle(parent.name, { create: true });
  try {
    await writeExact(entry, bytes);
  } catch (error) {
    // A failed write to a newly created handle can leave its empty file behind.
    if (!current) {
      try {
        const failed = await diskFile(directory, path);
        if (failed?.bytes.length === 0 && await entry.isSameEntry(failed.entry)) await parent.directory.removeEntry(parent.name);
      } catch {}
    }
    throw error;
  }
}

export async function replacePackage(directory, bundle, after, { targetHash, onBackup, readMarker }) {
  const afterFiles = await hashFiles(after);
  if (await hashInventory(afterFiles) !== targetHash) throw packageError("受け取ったパッケージのハッシュが一致しません。");
  const before = await inspectDirectory(directory, bundle.files, afterFiles);
  const paths = pathsFor(bundle.files, afterFiles).filter((path) => bundle.files[path] !== afterFiles[path]);
  if (!paths.includes(PACKAGE_INDEX) || !paths.includes("manifest.json")) throw packageError("更新用のマニフェストとインストール記録が必要です。");
  await onBackup({ format: PACKAGE_FORMAT, directory, before, beforeFiles: bundle.files, afterFiles, beforeHash: bundle.sha256, targetHash });
  // Touch only the index until Chrome confirms this is the loaded directory.
  await changeFile(directory, PACKAGE_INDEX, bundle.files[PACKAGE_INDEX], after[PACKAGE_INDEX]);
  if (await readMarker() !== afterFiles[PACKAGE_INDEX]) {
    throw namedError("FolderValidationError", "Chrome が読み込んだフォルダが選択されていません。");
  }
  for (const path of paths) {
    if (path === PACKAGE_INDEX || path === "manifest.json") continue;
    await changeFile(directory, path, bundle.files[path], after[path]);
  }
  await changeFile(directory, "manifest.json", bundle.files["manifest.json"], after["manifest.json"]);
  await inspectDirectory(directory, afterFiles, bundle.files);
}

export const verifyPackageDisk = (backup, updated) => updated
  ? inspectDirectory(backup.directory, backup.afterFiles, backup.beforeFiles)
  : inspectDirectory(backup.directory, backup.beforeFiles, backup.afterFiles);

export async function restorePackage(backup) {
  const { directory, before, beforeFiles, afterFiles, beforeHash, targetHash } = backup;
  if (await hashInventory(await hashFiles(before)) !== beforeHash || await hashInventory(beforeFiles) !== beforeHash ||
      await hashInventory(afterFiles) !== targetHash) throw packageError("バックアップのハッシュが一致しません。");
  if (await directory.queryPermission({ mode: "readwrite" }) !== "granted") {
    throw namedError("NotAllowedError", "フォルダの再許可が必要です。");
  }
  const paths = pathsFor(beforeFiles, afterFiles).filter((path) => beforeFiles[path] !== afterFiles[path]);
  const changed = [];
  for (const path of paths) {
    const current = (await diskFile(directory, path))?.hash;
    if (current === beforeFiles[path]) continue;
    if (current !== afterFiles[path]) throw namedError("SourceMismatchError", path + " に別の編集があるため復元できません。");
    changed.push(path);
  }
  // Keep the manifest at its current version until the other files are restored.
  const inOrder = [...changed.filter((path) => path !== "manifest.json"), ...changed.filter((path) => path === "manifest.json")];
  for (const path of inOrder) await changeFile(directory, path, afterFiles[path], before[path]);
  await verifyPackageDisk(backup, false);
}
