# Automatic updates for unpacked Chrome extensions via GitHub Releases

English · [日本語](README.ja.MD)

This project demonstrates how an unpacked Manifest V3 Chrome extension can update itself from GitHub Releases. While Chrome is running and write access is granted, the updater can apply a signed package and reload the extension so Chrome sees the new manifest version, scripts, and assets. The demo runs without the Chrome Web Store, Native Messaging, or an external program.

Follow the [demo setup](#try-the-demo) to get started. To adapt the updater to your own extension, see the [porting guide](PORTING.md). AI agents can start with [AGENTS.md](AGENTS.md). Both documents are in Japanese.

## Try the demo

1. Load the `extension` directory from this checkout, or extract an extension-only release's `auto-update-https.zip` to a new folder. Its manifest declares `options_ui.page` as `popup.html`. The ZIP filename is retained for release compatibility. [Releases](https://github.com/H4M4CHi-ttr/chrome-unpacked-self-update-lab/releases)
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that `extension` folder.
3. On first install, the extension opens its update settings. Click **Choose extension folder** (拡張機能フォルダを選ぶ), select the same folder, and grant read and write access to this test copy. To return to the tab, use **Open update settings** (更新設定を開く) from the popup.
4. Automatic updates start once the extension verifies the folder and has write access. If a later check finds that write access needs to be renewed, the extension brings its update settings to the front once. Click **Reauthorize saved folder** (保存したフォルダを再許可) and choose **Allow on every visit** (サイトアクセス時は常に許可) if Chrome offers it.
5. If you close the settings tab, the **!** badge will stay while write access is needed. In the popup, use **Open reauthorization** (再許可画面を開く) to return to settings. The extension reuses the folder you registered.
6. The first update check runs after about 30 seconds, then every five minutes while Chrome runs. After a compatible update is applied, check the version in `chrome://extensions` and look for `execution-confirmed` in the experiment log. Use **Stop automatic updates** to turn updates off. The extension remembers this choice when you reauthorize the folder.

Installations with the bundled updater (`v1.22.0` and later, including `v2.0.x`) can update to the latest 2.1 release through their existing folder registration. Automatic updates must be enabled and Chrome must grant write access.

**Migrating from the HTTPS updater.** Finish or restore any interrupted update in the old installation, then stop its monitoring. Load the new extension-only build once and register its folder in the extension. A folder grant belongs to the origin that received it. Remove the old GitHub Pages origin’s file access in Chrome's site controls. The archived Pages client supports older installations.

The public demo requires no GitHub token. When adapting the updater to a private repository, enable private mode and register a read-only, repository-scoped token in the extension popup. [Private repository setup](PORTING.md#プライベートリポジトリを使う場合)

## Demo release schedule

cron-job.org calls `workflow_dispatch` on `main` with `publish=true` at minute zero of each hour in `Asia/Tokyo`. The current release baseline is `v2.1.0`. Later scheduled releases increment the patch, for example `v2.1.1` and `v2.1.2`. The workflow publishes signed updates and an install ZIP at least 60 minutes after the previous release. A request within two minutes of that threshold waits until it is reached. Earlier requests exit before building.

To stop scheduled releases, disable the cron-job.org job. The job uses a fine-grained token scoped to this repository with read and write access to `Actions`. [Workflow](.github/workflows/hourly-demo-release.yml) · [GitHub dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)

When porting this updater, leave out the demo's cron schedule and prepare signed artifacts as part of your own release process. The extension checks for releases every five minutes using a Chrome alarm. [Porting guide](PORTING.md)

Maintainers can use **Run workflow** to build and verify the next version's signed artifacts. Select **Publish if at least 60 minutes have passed** to publish the next version under the same timing rule as scheduled runs.

## How updates work

1. The extension's service worker checks GitHub Releases, verifies the pinned-key signature on the package metadata, and checks the ZIP and each file against the signed hashes.
2. The worker reads the folder handle from the extension's IndexedDB and checks the current write permission. With access, it validates the installed files, saves a backup and uses the installation record to confirm the folder Chrome actually loaded. It updates the managed files and writes `manifest.json` last.
3. The worker reads the files back and calls `chrome.runtime.reload()`. The next worker compares the running code, manifest version and package hash before clearing the backup. The normal update runs with the popup and settings tab closed while Chrome grants access.

The extension runs while Chrome is open. If automatic updates are enabled when Chrome restarts, the extension recreates the alarm if needed and checks for releases at startup. Alarms will not wake a sleeping device, and Chrome may run them later than scheduled. [Chrome alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)

## Troubleshooting the ! badge

Open the extension popup to see what needs attention. Pin the extension from Chrome's extensions menu to see the badge in the toolbar.

| Situation | Action |
| --- | --- |
| Permission required | Reauthorize the saved folder. Choose **Allow on every visit** if Chrome offers it. Any verified update waits until Chrome grants write access. |
| Folder mismatch | Select the exact folder Chrome loaded. The updater checks for local edits and restores the installation record if it detects an identical copy. |
| Interrupted update | Choose **Restore the previous version**. Restoration also stops monitoring. If the extension's own settings cannot start, restore a known-good distribution ZIP manually. Keep this ZIP outside the installation folder. |
| Stop or disconnect | **Stop automatic updates** stops future checks. **Disconnect folder** also discards the stored handle and pending candidate. An update already in progress may finish first. |

## Test results

The 2.1 reauthorization flow was tested in Chrome 157 with simulated file-access permissions. An alarm brought the settings tab forward once. The next alarm left the active tab alone, and granting access again cleared the badge. [Worker regression test](tests/package.test.mjs)

On November 20, 2026 (Japan time), the worker updated a real unpacked installation on Windows 11 and Chrome 157.0.8103.79. With the settings tab closed, two alarms applied `1.0.0 → 1.1.0 → 1.2.0`. After Chrome restarted with the same profile, the extension was still registered and its startup check applied `1.3.0`. Each time, Chrome reported the new manifest version, a fresh worker ran the updated code, and all 16 files on disk matched the signed ZIP byte for byte.

On the first revisit to settings, the saved folder needed one read/write reauthorization. All three subsequent updates ran without another permission prompt. The test used a loopback GitHub Releases fixture, a test P-256 signing key and a 30-second alarm interval. A separate check against the public GitHub release v1.21.0 verified the signature and all 17 files. The extension declined to apply that release because its manifest still requested the old web updater’s host permission. [Extension-only update record](evidence/internal-update.json)

The current worker regression test fetches a signed release, holds it when write access needs a prompt, restores an identical copy selected by mistake, and clears the backup only after a fresh worker confirms the updated version and package hash. It uses test doubles for Chrome APIs and file handles. [Worker test](tests/package.test.mjs)

On Windows, Chrome 157 opened the bundled settings tab from the toolbar action and downloaded a signed candidate. Given an identical copy in the extension’s origin-private file system, the worker detected the folder mismatch, restored the copy and left the installed files intact. The test used a loopback release server and a dummy token. [Chrome folder check](evidence/internal-copy-check.json)

The following reports cover the earlier implementations in real Chrome.

- The HTTPS updater experiment verified alarms, opening and reusing tabs, writing the file on disk, and starting the updated code. [HTTPS updater results](HTTPS-RESULTS.md)
- In the direct-write experiment, signature verification passed and the folder permission returned to `prompt` after the extension reloaded. [Direct-write experiment](RESULTS.md)
- The permission isolation experiment recorded what happens after a full Chrome restart when the HTTPS updater has folder access. It also compares this approach with updating the module without reloading the extension. [Permission isolation experiment](experiments/permission-isolation/RESULTS.md)

Automatic updates cover the files in the signed list, including changes to the manifest's version, name, description, and icons. Changes to permissions, extension identity, the signing key, or the settings entry point require manually loading a new ZIP. The release still includes `update.zip` for older `active.js`-only installations. Do not use this approach for Chrome Web Store distribution, even with signed releases. [Chrome's guidance on remotely hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)

## Tests and installation record

Run these commands with Node.js 22 or later. No additional packages are required.

~~~powershell
node --test tests/*.test.mjs
node tools/build-release.mjs --check-index
node tools/verify-live-evidence.mjs
node tools/verify-isolation-evidence.mjs
node tools/verify-https-evidence.mjs
~~~

Before loading the source checkout in Chrome, run `node tools/build-release.mjs --refresh-index` to record the hashes of the current extension files. Use a separate folder for testing. Sign packages with `build-release.mjs` as described in the [porting guide](PORTING.md). The older `build-fixtures.mjs` script replaces the seed code and public key and is only for reproducing the old experiment.

The demo uses the bundled fflate 0.8.3 for ZIP processing. [MIT license](extension/vendor/LICENSE.fflate)
