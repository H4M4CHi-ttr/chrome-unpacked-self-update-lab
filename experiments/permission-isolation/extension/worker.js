import { version as compiledVersion } from "./active.js";
import { equalBytes, loadBundle, readOwn } from "./core.js";
import { isAllowedWebSender, isValidMessage } from "./policy.js";

const bootId = crypto.randomUUID();
const info = () => ({ bootId, compiledVersion });

function handle(message, sendResponse) {
  if (!isValidMessage(message)) { sendResponse({ error: "Unsupported request" }); return; }
  const task = async () => {
    if (message.action === "info") return info();
    if (message.action === "snapshot") {
      const bundle = await loadBundle();
      return { ...info(), files: Object.fromEntries(Object.entries(bundle.files).map(([name, bytes]) => [name, Array.from(bytes)])), active: Array.from(bundle.active) };
    }
    const active = await readOwn("active.js");
    const expected = await readOwn(`variants/${message.version}.js`);
    if (!equalBytes(active, expected)) throw new Error("Installed source differs from the requested fixture");
    setTimeout(() => chrome.runtime.reload(), 150);
    return { accepted: true, previousBootId: bootId, targetVersion: message.version };
  };
  task().then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  return handle(message, sendResponse);
});
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isAllowedWebSender(sender)) { sendResponse({ error: "Untrusted sender" }); return; }
  return handle(message, sendResponse);
});
