export const PROTOCOL = "permission-isolation-v1";
export const UPDATER_URL = "https://h4m4chi-ttr.github.io/chrome-unpacked-self-update-lab/isolation/";
export const VERSIONS = ["0.2.0", "0.2.1", "0.2.2", "0.2.3", "0.2.4"];

export function isAllowedWebSender(sender) {
  try {
    const actual = new URL(sender.url);
    const expected = new URL(UPDATER_URL);
    return actual.origin === expected.origin && [expected.pathname, `${expected.pathname}index.html`].includes(actual.pathname);
  } catch { return false; }
}

export function isValidMessage(message) {
  if (!message || message.protocol !== PROTOCOL) return false;
  if (message.action === "snapshot" || message.action === "info") return true;
  return message.action === "reload" && VERSIONS.includes(message.version);
}
