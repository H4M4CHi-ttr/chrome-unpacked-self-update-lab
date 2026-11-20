import { unzipSync } from "./vendor/fflate.js";
import { MAX_CODE_BYTES, MAX_ZIP_BYTES, REPOSITORY } from "./config.js";
import { namedError, sha256 } from "./core.js";
import {
  PACKAGE_FORMAT, PACKAGE_INDEX, PACKAGE_LIMIT, PACKAGE_METADATA, PACKAGE_SIGNATURE, PACKAGE_ZIP,
  assertManifestVersion, hashFiles, hashInventory, packageInventory, validateInventory,
} from "./package.js";

export function compareVersions(left, right) {
  const parse = (value) => {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw namedError("ReleaseError", "通常リリースの版番号 x.y.z が必要です。");
    const parts = value.split(".").map(Number);
    if (parts.some((part) => !Number.isSafeInteger(part))) throw namedError("ReleaseError", "版番号が大きすぎます。");
    return parts;
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

export async function fetchLimited(url, limit, options = {}) {
  const response = await fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(20000), ...options });
  if (!response.ok) {
    const { status } = response;
    const denied = status === 403 && response.headers.get("x-ratelimit-remaining") !== "0" && !response.headers.has("retry-after");
    if (options.headers?.Authorization && (status === 401 || status === 404 || denied)) {
      throw namedError("ReleaseAccessError", `GitHub Releases を取得できません (HTTP ${status})。トークンの有効期限、対象リポジトリの読み取り権限、通常リリースの有無を確認してください。`);
    }
    const error = namedError("NetworkError", `HTTP ${status}: ${new URL(url).hostname}`);
    if (status === 403 || status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      error.retryAt = Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 15 * 60 * 1000;
    }
    throw error;
  }
  if (Number(response.headers.get("content-length")) > limit) throw namedError("ReleaseError", "配信ファイルがサイズ上限を超えています。");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw namedError("ReleaseError", "配信ファイルがサイズ上限を超えています。");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

const decodeJSON = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases`;

function githubHeaders(accept, token) {
  if (!token) return { Accept: accept };
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) {
    throw namedError("ReleaseAccessError", "ポップアップで有効な GitHub アクセストークンを登録してください。");
  }
  return { Accept: accept, Authorization: "Bearer " + token };
}

export async function latestRelease(token) {
  const bytes = await fetchLimited(RELEASES_API + "/latest", 512 * 1024, {
    headers: githubHeaders("application/vnd.github+json", token), redirect: token ? "error" : "follow",
  });
  const release = decodeJSON(bytes);
  if (release.draft || release.prerelease || !Array.isArray(release.assets) || typeof release.tag_name !== "string") throw namedError("ReleaseError", "通常の公開リリースではありません。");
  const version = release.tag_name.replace(/^v/, "");
  compareVersions(version, version);
  return { ...release, version };
}

function fetchAsset(release, name, limit, token) {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) throw namedError("ReleaseError", `配信アセットは1個必要です: ${name}`);
  const asset = matches[0];
  if (token) {
    if (!Number.isSafeInteger(asset.id) || asset.id < 1) throw namedError("ReleaseError", "配信アセットの ID が不正です。");
    // Fetch removes Authorization when GitHub redirects the download to another origin.
    return fetchLimited(RELEASES_API + "/assets/" + asset.id, limit, {
      headers: githubHeaders("application/octet-stream", token), redirect: "follow",
    });
  }
  const url = new URL(asset.browser_download_url);
  const expected = `/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expected || url.search || url.hash) throw namedError("ReleaseError", "想定外の配信 URL です。");
  return fetchLimited(url.href, limit);
}

async function verifySignedRelease(raw, signature, publicKey, version, tag) {
  if (signature.length !== 64) throw namedError("SignatureError", "署名の形式が不正です。");
  const key = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, raw)) throw namedError("SignatureError", "配信情報の署名が一致しません。");
  const info = decodeJSON(raw);
  if (info?.repository !== REPOSITORY || info.version !== version || info.tag !== tag) {
    throw namedError("ReleaseError", "署名済み配信情報の対象・バージョン・タグが一致しません。");
  }
  return info;
}

export async function verifyManifest(raw, signature, publicKey, version, tag) {
  const info = await verifySignedRelease(raw, signature, publicKey, version, tag);
  const validSize = (size, max) => Number.isSafeInteger(size) && size > 0 && size <= max;
  const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (info.format !== 1 ||
      info.file?.path !== "active.js" || !validSize(info.file.bytes, MAX_CODE_BYTES) || !validHash(info.file.sha256) ||
      !validSize(info.zip?.bytes, MAX_ZIP_BYTES) || !validHash(info.zip.sha256)) throw namedError("ReleaseError", "署名済み配信情報の対象・版・パス・サイズが不正です。");
  return info;
}

export async function unpackVerified(zip, info) {
  if (zip.length !== info.zip.bytes || await sha256(zip) !== info.zip.sha256) throw namedError("IntegrityError", "ZIP の SHA-256 またはサイズが一致しません。");
  const names = [];
  const files = unzipSync(zip, { filter: (file) => {
    names.push(file.name);
    if (file.name !== "active.js" || file.originalSize !== info.file.bytes || file.originalSize > MAX_CODE_BYTES) throw namedError("ReleaseError", "ZIP に許可していないファイルが含まれています。");
    return true;
  } });
  if (names.length !== 1 || names[0] !== "active.js" || !files["active.js"]) throw namedError("ReleaseError", "ZIP には active.js だけを格納してください。");
  const code = files["active.js"];
  if (code.length !== info.file.bytes || await sha256(code) !== info.file.sha256) throw namedError("IntegrityError", "展開した active.js の SHA-256 またはサイズが一致しません。");
  return code;
}

export async function verifyPackageManifest(raw, signature, publicKey, version, tag) {
  const info = await verifySignedRelease(raw, signature, publicKey, version, tag);
  if (info.format !== PACKAGE_FORMAT || !Number.isSafeInteger(info.zip?.bytes) ||
      info.zip.bytes < 1 || info.zip.bytes > PACKAGE_LIMIT || !/^[a-f0-9]{64}$/.test(info.zip.sha256 ?? "")) {
    throw namedError("ReleaseError", "パッケージの配信形式・サイズ・ハッシュが不正です。");
  }
  validateInventory(info.files);
  return info;
}

export async function unpackPackage(zip, info) {
  if (zip.length !== info.zip.bytes || await sha256(zip) !== info.zip.sha256) {
    throw namedError("IntegrityError", "パッケージ ZIP の SHA-256 またはサイズが一致しません。");
  }
  const seen = new Set();
  let total = 0;
  const archive = unzipSync(zip, { filter: (entry) => {
    const prefix = "extension/";
    const path = entry.name.slice(prefix.length);
    total += entry.originalSize;
    if (!entry.name.startsWith(prefix) || !Object.hasOwn(info.files, path) || seen.has(path) || total > PACKAGE_LIMIT) {
      throw namedError("ReleaseError", "パッケージ ZIP のパス・重複・展開サイズが不正です。");
    }
    seen.add(path);
    return true;
  } });
  const files = Object.fromEntries(Object.entries(archive).map(([path, bytes]) => [path.slice("extension/".length), bytes]));
  if (seen.size !== Object.keys(info.files).length || Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) > PACKAGE_LIMIT) {
    throw namedError("ReleaseError", "パッケージ ZIP のファイル数またはサイズが一致しません。");
  }
  const sha256sum = await hashInventory(info.files);
  const index = await packageInventory(files[PACKAGE_INDEX]);
  assertManifestVersion(files["manifest.json"], info.version);
  if (index.version !== info.version || index.sha256 !== sha256sum || await hashInventory(await hashFiles(files)) !== sha256sum) {
    throw namedError("IntegrityError", "パッケージとファイル一覧が一致しません。");
  }
  return { format: PACKAGE_FORMAT, version: info.version, tag: info.tag, sha256: sha256sum, files };
}

export async function downloadPackage(release, publicKey, token) {
  const raw = await fetchAsset(release, PACKAGE_METADATA, 32 * 1024, token);
  const signature = await fetchAsset(release, PACKAGE_SIGNATURE, 64, token);
  const info = await verifyPackageManifest(raw, signature, publicKey, release.version, release.tag_name);
  return unpackPackage(await fetchAsset(release, PACKAGE_ZIP, info.zip.bytes, token), info);
}
