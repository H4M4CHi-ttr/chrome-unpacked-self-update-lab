# Automatic updates for unpacked Chrome extensions via GitHub Releases

English · [日本語](README.ja.MD)

This project demonstrates how an unpacked Manifest V3 Chrome extension can update itself from GitHub Releases. While Chrome is running and write access is granted, the updater can apply a signed package and reload the extension so Chrome sees the new manifest version, scripts, and assets. The demo runs without the Chrome Web Store, Native Messaging, or an external program.

Follow the [demo setup](#try-the-demo) to get started. To adapt the updater to your own extension, see the [porting guide](PORTING.md). AI agents can start with [AGENTS.md](AGENTS.md). Both documents are in Japanese.

## Try the demo

1. In [Releases](https://github.com/H4M4CHi-ttr/chrome-unpacked-self-update-lab/releases), choose a release with `package-update.json` and `package-update.sig`. Download `auto-update-https.zip` from the same release and extract it to a new folder. Install from this ZIP once when moving from an older setup that only updates `active.js`.
2. Open `chrome://extensions` and turn on **Developer mode**. Click **Load unpacked** and select the extracted `extension` folder. Open **GitHub 自己更新実験** from the toolbar and check that the extension version (拡張機能のバージョン) matches the release.
3. In the extension, click **Open HTTPS updater** (HTTPS 更新ページを開く). On that page, click **Choose extension folder** (拡張機能フォルダを選ぶ), select the **same `extension` folder** you loaded in step 2, and grant read and write access. If Chrome offers **Allow on every visit** (サイトアクセス時は常に許可), select it. If it does not appear on the first visit, close and reopen the updater tab, then click **Reauthorize saved folder** (保存したフォルダを再許可) to see whether the option is available. Automatic updates can still run during the current session while Chrome allows writes.
4. Click **Enable automatic updates** (自動更新を有効にする) and close the setup page. The first check is scheduled about 30 seconds later. The extension then checks every five minutes. To check immediately, click **Check now** (今すぐ確認) in the extension.
5. When a newer [latest release](https://github.com/H4M4CHi-ttr/chrome-unpacked-self-update-lab/releases/latest) is available, check that the version in `chrome://extensions` has changed and the experiment log (実験ログ) contains `execution-confirmed`. The SHA-256 of each installed file should match its entry in `package-update.json`.

The extension cannot discover its folder on disk automatically, so you need to select it in step 3. Chrome grants the updater site access to the entire folder you choose. Grant this public demo access only to a test copy. If you use a separate Chrome profile, load the extension and grant folder access in that same profile.

## Demo release schedule

The GitHub Actions workflow is scheduled at 17, 37, and 57 minutes past each hour. If at least 60 minutes have passed since the latest release was published, the workflow increments the minor version by one and publishes a signed update and a ZIP for fresh installs. If less time has passed, the run exits before building.

The extra slots give the workflow another chance to run if a scheduled run is skipped. GitHub can delay or skip runs during periods of high load. To stop scheduled releases, disable **Hourly demo release** in the Actions tab. [Workflow](.github/workflows/hourly-demo-release.yml) · [GitHub schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

When porting this updater, leave out the demo's cron schedule and prepare signed artifacts as part of your own release process. The extension checks for releases every five minutes using a Chrome alarm. [Porting guide](PORTING.md)

Maintainers can use **Run workflow** to build and verify the next version's signed artifacts. Select **Publish if at least 60 minutes have passed** to publish the next version under the same timing rule as scheduled runs.

## How updates work

1. The service worker checks the latest release and verifies the signature on the file list, the package ZIP hash, and every file in the ZIP.
2. If automatic updates are enabled and a verified newer version is available, the service worker opens the HTTPS updater in a background tab for that extension ID. If a matching tab already exists, it reuses that tab without switching the active tab.
3. The updater restores its directory handle from IndexedDB and checks the installed files against the installation record. It saves a backup, proves Chrome is loading from that folder, and applies additions, replacements, and deletions of managed files. It writes `manifest.json` last.
4. The extension verifies the written package and reloads. The new service worker confirms that Chrome loaded the expected manifest version and that the files match the signed release. The updater keeps the backup until it receives that confirmation.

The extension runs while Chrome is open. If automatic updates are enabled when Chrome restarts, the extension recreates the alarm if needed and checks for releases at startup. Alarms will not wake a sleeping device, and Chrome may run them later than scheduled. [Chrome alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)

## Troubleshooting the ! badge

If the extension shows a `!`, open the HTTPS updater to find out what happened.

| Status or action | What to do |
| --- | --- |
| Permission required (許可が必要) | Open the HTTPS updater from the extension and click **Reauthorize saved folder** (保存したフォルダを再許可). You only need to do this if access to the folder you chose earlier has been lost. |
| Choose the folder again (フォルダを選び直す) | Choose the same `extension` folder you loaded in Chrome. |
| Check an interrupted update (中断した更新を確認) | Open the HTTPS updater to compare the files on disk with the update record. Click **Restore previous version** (中断した更新を旧版に戻す) to restore the previous package and stop checking for updates. Keep the updater URL as a way back if Chrome cannot load the extension. |
| Stop automatic updates (自動更新を止める) | Click **Stop automatic updates** (自動更新を停止) in the extension. A write that has already started may finish. To revoke the site's permission as well, remove it from the file access settings in Chrome's address bar. |

Once the updater detects that it needs permission again, later checks stop reopening the tab or showing permission dialogs. It detects an identical copy by checking whether a change to the installation record is visible to Chrome. A mismatch triggers recovery before other files are changed. The File System Access API writes one file at a time, so recovery may be needed after an interruption. Recovery does not overwrite other edits it detects. Keep the original ZIP in case the browser data needed for recovery is cleared.

## Test results

Before reading the implementation, see what each experiment verified. The reports are in Japanese.

- The HTTPS updater experiment verified alarms, opening and reusing tabs, writing the file on disk, and starting the updated code. [HTTPS updater results](HTTPS-RESULTS.md)
- In the direct-write experiment, signature verification passed and the folder permission returned to `prompt` after the extension reloaded. [Direct-write experiment](RESULTS.md)
- The permission isolation experiment recorded what happens after a full Chrome restart when the HTTPS updater has folder access. It also compares this approach with updating the module without reloading the extension. [Permission isolation experiment](experiments/permission-isolation/RESULTS.md)

Automatic updates cover the files in the signed list, including changes to the manifest's version, name, description, and icons. Changes to permissions, extension identity, the signing key, or the updater connection require manually loading a new ZIP. The release still includes `update.zip` for older `active.js`-only installations. Do not use this approach for Chrome Web Store distribution, even with signed releases. [Chrome's guidance on remotely hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)

## Tests and updater page sync

Run these commands with Node.js 22 or later. No additional packages are required.

~~~powershell
node --test tests/*.test.mjs
node tools/sync-updater.mjs --check
node tools/verify-live-evidence.mjs
node tools/verify-isolation-evidence.mjs
node tools/verify-https-evidence.mjs
~~~

Run `node tools/sync-updater.mjs` after changing files shared by the extension and the HTTPS updater. Before loading the source checkout in Chrome, run `node tools/build-release.mjs --refresh-index` to record the hashes of the current extension files. Use a separate folder for testing. Sign packages with `build-release.mjs` as described in the [porting guide](PORTING.md). The older `build-fixtures.mjs` script replaces the seed code and public key and is only for reproducing the old experiment.

The demo uses the bundled fflate 0.8.3 for ZIP processing. [MIT license](extension/vendor/LICENSE.fflate)
