# このリポジトリを変更・移植する AI エージェントへ

これは開発者モードで読み込む Chrome 拡張機能の実装例です。再読み込み後に Chrome が署名付きリリースの manifest のバージョンを読み込み、管理対象のファイルがディスク上で一致したことを確認してください。

## 最初に読むファイル

1. [日本語 README](README.ja.MD)：インストールと初回許可、期待する動作、検証結果への入口。
2. [extension/worker.js](extension/worker.js)：アラーム、署名済み候補の保存、タブ起動、外部 RPC、再読み込みの記録。
3. [docs/updater/client.js](docs/updater/client.js)：ユーザーのフォルダ選択、許可の復元、書き込み、書き込み後の確認。
4. [extension/release.js](extension/release.js) と [extension/core.js](extension/core.js)：配信物とフォルダの照合、書き込みと復元。
5. [移植ガイド](PORTING.md)：自分のリポジトリ、HTTPS オリジン、署名鍵に差し替える手順。作業依頼に使えるプロンプトもあります。

## 更新の境界を保つ

- 拡張機能だけが GitHub Releases を読み、固定した公開鍵で `package-update.json` を検証します。ZIP と各ファイルのハッシュ、パス、配信先、バージョンを照合します。旧版向けの `update.json` は `active.js` だけに使います。
- HTTPS ページはブラウザでユーザーが選んだハンドルを、そのサイトの IndexedDB に拡張機能 ID ごとに保存します。ハンドルや OS パスをメッセージで渡さないでください。権限のないときは更新を停止し、ユーザー操作のボタンからだけ権限を求めます。
- 外部メッセージを受ける条件は manifest の externally_connectable と bridge.js の正確なオリジン・パス・トップフレーム・対象 ID です。書き込み先を RPC や ZIP から指定させないでください。
- `extension/package.js` は管理対象のファイルだけを追加・置換・削除します。バックアップを保存し、Chrome の読み込み元を照合してから書き込みます。`manifest.json` は最後に書き、Chrome が新版を読み込んだと確認できるまで復元用データを残します。権限・拡張機能の識別子・署名鍵・更新ページへの接続設定の変更は、手動で読み込み直す手順に回します。
- extension/bridge.js、core.js、store.js、package.js を変更したら、node tools/sync-updater.mjs で docs/updater の配信用コピーを更新してください。拡張機能のソースを変更したら node tools/build-release.mjs --refresh-index で install.json を更新してください。
- 実際のフォルダを壊さないよう、検証は一時 Chrome プロファイルと配布物のコピーで行います。公開リリースや Pages は、変更が明示的に依頼されたときにだけ更新してください。

## 移植先にデモ用の cron を持ち込まない

`.github/workflows/hourly-demo-release.yml` は、この公開デモの更新を繰り返し試すために、毎時3回起動を試し、公開間隔を60分以上空けてマイナー版を上げます。他の拡張機能へ実装するときは、このワークフローや cron、自動採番をコピーしないでください。移植先では既存のリリース手順に合わせ、明示したタグや承認した公開操作で署名と配信を行ってください。Chrome 側の定期確認は実装の参考にできます。

## 完了判定

node --test tests/*.test.mjs と node tools/sync-updater.mjs --check を実行してください。実機では、更新ページを閉じた状態からの自動起動、選択中のタブを切り替えないこと、既存タブの再利用、Chrome の完全再起動後、許可の取り消し、異なるフォルダを試します。開始時と終了時に active.js の SHA-256、実行版、サービスワーカーの起動 ID を記録してください。再現していない挙動は未検証と明記します。
