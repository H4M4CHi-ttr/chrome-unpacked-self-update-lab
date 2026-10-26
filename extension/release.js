import { unzipSync } from "./vendor/fflate.js";
import { MAX_CODE_BYTES, MAX_ZIP_BYTES, REPOSITORY } from "./config.js";
import { namedError, sha256 } from "./core.js";

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
    const error = namedError("NetworkError", `HTTP ${response.status}: ${new URL(url).hostname}`);
    if (response.status === 403 || response.status === 429) {
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

export async function latestRelease() {
  const bytes = await fetchLimited(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, 512 * 1024, { headers: { Accept: "application/vnd.github+json" } });
  const release = decodeJSON(bytes);
  if (release.draft || release.prerelease || !Array.isArray(release.assets) || typeof release.tag_name !== "string") throw namedError("ReleaseError", "通常の公開リリースではありません。");
  const version = release.tag_name.replace(/^v/, "");
  compareVersions(version, version);
  return { ...release, version };
}

function assetURL(release, name) {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) throw namedError("ReleaseError", `配信アセットは1個必要です: ${name}`);
  const url = new URL(matches[0].browser_download_url);
  const expected = `/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expected || url.search || url.hash) throw namedError("ReleaseError", "想定外の配信 URL です。");
  return url.href;
}

export async function verifyManifest(raw, signature, publicKey, version, tag) {
  if (signature.length !== 64) throw namedError("SignatureError", "署名の形式が不正です。");
  const key = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, raw)) throw namedError("SignatureError", "配信情報の署名が一致しません。");
  const info = decodeJSON(raw);
  const validSize = (size, max) => Number.isSafeInteger(size) && size > 0 && size <= max;
  const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (info.format !== 1 || info.repository !== REPOSITORY || info.version !== version || info.tag !== tag ||
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

export async function downloadCandidate(release, publicKey) {
  const raw = await fetchLimited(assetURL(release, "update.json"), 8192);
  const signature = await fetchLimited(assetURL(release, "update.sig"), 64);
  const info = await verifyManifest(raw, signature, publicKey, release.version, release.tag_name);
  const zip = await fetchLimited(assetURL(release, "update.zip"), info.zip.bytes);
  return { version: info.version, tag: info.tag, sha256: info.file.sha256, code: await unpackVerified(zip, info) };
}
