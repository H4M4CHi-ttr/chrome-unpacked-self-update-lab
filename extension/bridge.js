export const PROTOCOL = "unpacked-https-updater-v1";
export const UPDATER_URL = "https://h4m4chi-ttr.github.io/chrome-unpacked-self-update-lab/updater/";
export const LOCK = "github-unpacked-self-update-lab";
export const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isToken = (value) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

export function isAllowedWebSender(sender) {
  try {
    const actual = new URL(sender.url), expected = new URL(UPDATER_URL);
    return sender.frameId === 0 && actual.origin === expected.origin && (!sender.origin || sender.origin === expected.origin) &&
      [expected.pathname, `${expected.pathname}index.html`].includes(actual.pathname);
  } catch { return false; }
}

export function isValidMessage(message) {
  if (!message || message.protocol !== PROTOCOL) return false;
  if (["info", "snapshot", "hash", "package-marker", "plan", "enable", "unblock"].includes(message.action)) return true;
  if (message.action === "permission") return ["granted", "prompt", "denied", "not-selected"].includes(message.permission);
  if (message.action === "attention") return ["folder", "recovery"].includes(message.cause);
  if (message.action === "begin") return isToken(message.token) && isHash(message.beforeHash) && isHash(message.targetHash);
  if (message.action === "cancel") return isToken(message.token) && (message.pause === undefined || typeof message.pause === "boolean");
  return message.action === "commit" && isToken(message.token);
}

export function updaterURL(id) {
  const url = new URL(UPDATER_URL);
  url.searchParams.set("id", id);
  return url.href;
}

export function isUpdaterTab(tab, id) {
  try {
    return isAllowedWebSender({ url: tab.url, frameId: 0 }) && new URL(tab.url).searchParams.get("id") === id;
  } catch { return false; }
}
