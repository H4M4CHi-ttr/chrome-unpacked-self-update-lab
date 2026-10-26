import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL, UPDATER_URL, isAllowedWebSender, isValidMessage } from "../experiments/permission-isolation/extension/policy.js";

test("accepts only the exact HTTPS updater page", () => {
  assert.ok(isAllowedWebSender({ url: `${UPDATER_URL}?id=test` }));
  assert.ok(isAllowedWebSender({ url: `${UPDATER_URL}index.html` }));
  for (const url of [undefined, "https://example.com/", UPDATER_URL.replace("https:", "http:"), `${UPDATER_URL}other.html`, UPDATER_URL.replace("/isolation/", "/isolation-evil/"), "https://h4m4chi-ttr.github.io.evil.example/chrome-unpacked-self-update-lab/isolation/"]) assert.equal(isAllowedWebSender({ url }), false);
});

test("rejects unexpected protocols, actions and source versions", () => {
  assert.ok(isValidMessage({ protocol: PROTOCOL, action: "snapshot" }));
  assert.ok(isValidMessage({ protocol: PROTOCOL, action: "reload", version: "0.2.3" }));
  for (const request of [null, {}, { protocol: "other", action: "reload", version: "0.2.3" }, { protocol: PROTOCOL, action: "write" }, { protocol: PROTOCOL, action: "reload", version: "../../active.js" }]) assert.equal(isValidMessage(request), false);
});
