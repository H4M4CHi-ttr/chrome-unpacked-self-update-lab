export const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

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

export async function readOwn(filename, limit = Infinity) {
  const url = new URL(chrome.runtime.getURL(filename));
  url.searchParams.set("read", crypto.randomUUID());
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${filename}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw namedError("SourceMismatchError", filename + " がサイズ上限を超えています。");
  return bytes;
}

export async function writeExact(file, bytes) {
  const stream = await file.createWritable({ keepExistingData: false });
  try { await stream.write(bytes); await stream.close(); }
  catch (error) { try { await stream.abort(); } catch {} throw error; }
  if (!equalBytes(await readBytes(file), bytes)) throw namedError("VerificationError", file.name + " の書き込み後の内容が一致しません。");
}
