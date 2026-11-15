# Chrome 開発者モード向け GitHub Releases 自動更新

**初回にフォルダを選んで許可すると、Chrome を開いている間は GitHub Releases の新版を検出し、実際の JavaScript を無操作で更新できる実装例です。** Manifest V3 のパッケージ化されていない拡張機能向けです。Chrome ウェブストア、Native Messaging、実行時の外部プログラムは使いません。

設定する方は下の「デモを試す」を読んでください。自分の拡張機能へ組み込む方は [移植ガイド](PORTING.md)、AI エージェントは [AGENTS.md](AGENTS.md) から始められます。

## デモを試す：許可と有効化は初回だけ

1. [v1.0.0 の実験用 ZIP](https://github.com/H4M4CHi-ttr/chrome-unpacked-self-update-lab/releases/download/v1.0.0/auto-update-https.zip) をダウンロードし、新しいフォルダに展開します。v0.x から試し直す場合も、この ZIP から始めてください。v1.0.0 で配信の署名鍵を切り替えました。
2. Chrome の chrome://extensions で開発者モードをオンにし、「パッケージ化されていない拡張機能を読み込む」から展開した extension フォルダを選びます。ツールバーの「GitHub 自己更新実験」を開き、コード版が 1.0.0 であることを確認します。
3. 「HTTPS 更新ページを開く」から「拡張機能フォルダを選ぶ」を押し、手順2で読み込んだ **同じ extension フォルダ** を選んで読み書きを許可します。Chrome が「サイトアクセス時は常に許可」を提示したら選びます。最初にその選択肢が出ない場合は、いったんタブを閉じて、次回の「保存したフォルダを再許可」で選べるか確認します。選択肢が出なくても、そのセッションで許可が有効な間は動作します。
4. 「自動更新を有効にする」を押し、設定ページを閉じます。最初の確認は約30秒後で、その後は5分おきに確認します。すぐ試す場合は、拡張機能の「今すぐ確認」を押してください。
5. [最新リリース](https://github.com/H4M4CHi-ttr/chrome-unpacked-self-update-lab/releases/latest) が v1.0.0 より新しくなったら、拡張機能の「実行中のコード版」と実験ログの `execution-confirmed` を確認します。ディスク上の `active.js` の SHA-256 は、適用したリリースの `update.json` の `file.sha256` と一致します。

拡張機能から OS 上のフォルダを自動で取得できないため、手順3のフォルダ選択は必要です。選択したフォルダ全体に対する許可を Chrome がサイトに付与します。この公開デモには実験用のコピーだけを許可してください。ブラウザで別プロファイルを使う場合は、拡張機能の読み込みからフォルダ許可まで同じプロファイルで行います。

## 毎時3回確認し、公開間隔を60分以上空ける

GitHub Actions は毎時17分・37分・57分に起動を試します。最新版の公開から60分以上経っていれば、マイナー版を1つ上げて署名付き更新と新規インストール用 ZIP を公開します。60分未満ならビルド前に終了します。起動枠を増やすと取りこぼしを補えますが、GitHub の混雑時には実行が遅れたり、見送られたりする場合があります。停止するには Actions 画面で「Hourly demo release」を無効にします。[ワークフロー](.github/workflows/hourly-demo-release.yml) · [GitHub のスケジュール仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

移植時は毎時の cron をコピーせず、自分のプロジェクトのリリース時に署名済みの配信物を用意してください。Chrome 拡張機能が5分おきに Releases を確認する処理とは別の設定です。[移植ガイド](PORTING.md)

メンテナーが Actions の「Run workflow」を押すと、次版のビルドと署名を確認できます。「Publish if at least 60 minutes have passed」を選ぶと、定期実行と同じ条件で次版を公開します。

## 新版があるときだけ更新タブを開く

1. 拡張機能のサービスワーカーが latest を確認します。署名を検証し、ZIP から指定の active.js だけを取り出します。
2. 検証済みの新版があり自動更新が有効なら、同じ拡張機能 ID の HTTPS タブを背面で開きます。すでに対応するタブがあれば、選択中のタブを切り替えずに更新ページを再利用します。
3. 更新ページは IndexedDB から選択済みフォルダを復元します。許可が有効なら旧ソースを保存してから active.js を置き換えます。Chrome に読み込まれたファイルも照合し、対象拡張機能だけを再読み込みします。
4. 新しいサービスワーカーが署名で指定された版とハッシュを確認します。その記録が取れた時点でバックアップを解放します。

Chrome を閉じている間は動きません。自動更新を有効にした状態で Chrome を再起動すると、アラームを確保し、その場でもリリースを確認します。スリープ中に Chrome が端末を起こしたり、毎回正確な時刻に実行したりはしません。[Chrome alarms の仕様](https://developer.chrome.com/docs/extensions/reference/api/alarms) を参照してください。

## 「!」が出たら更新ページで理由を確認する

| 表示 | 操作 |
| --- | --- |
| 許可が必要 | 拡張機能から HTTPS 更新ページを開き、「保存したフォルダを再許可」。選択済みのフォルダを使います。Chrome が許可を失った場合だけ必要です。 |
| フォルダを選び直す | Chrome に読み込んだときに指定した、同じ `extension` フォルダを選びます。 |
| 中断した更新を確認 | HTTPS 更新ページを開くとディスクと記録を照合します。「中断した更新を旧版に戻す」を押すと、旧版に戻して監視を止めます。 |
| 自動更新を止める | 拡張機能の「自動更新を停止」を押します。すでに始まった書き込みは完了する場合があります。サイトの許可も取り消すには、Chrome のアドレスバーのファイルアクセス設定から削除します。 |

再許可が必要と分かった後は、確認のたびにタブや許可ダイアログを繰り返し開きません。別コピーへの一時的な書き込みは Chrome 側の照合で検出して元に戻します。外部エディタや同期ソフトが並行して編集したファイルは自動で上書き復元しません。復旧に必要なブラウザデータまで消去された場合に備え、元の配布 ZIP は保管してください。

## 実装を読む前に、何を実測したかを見る

- [今回の自動連携の実測](HTTPS-RESULTS.md)：アラーム、タブ起動・再利用、実ファイルと新版起動の確認。
- [拡張機能が直接書き込んだ比較実験](RESULTS.md)：リリースの署名検証は通っても、拡張の再読み込みで許可が prompt に戻った例。
- [許可の所有者を分離した比較実験](experiments/permission-isolation/RESULTS.md)：ホット更新との比較、HTTPS の許可を選んだ場合の完全再起動後の実測。

この実装の更新先は既存の active.js だけです。manifest、サービスワーカーの更新基盤、複数ファイルの展開や削除は扱いません。署名付きであっても Web Store 用の配信方式としては使わないでください。[Chrome のリモート配信コードの説明](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) を参照してください。

## 変更したらテストと配信ページの同期を行う

Node.js 22 以降で、パッケージのインストールなしで実行できます。

~~~powershell
node --test tests/*.test.mjs
node tools/sync-updater.mjs --check
node tools/verify-live-evidence.mjs
node tools/verify-isolation-evidence.mjs
node tools/verify-https-evidence.mjs
~~~

拡張機能と HTTPS ページで共用するファイルの変更後は `node tools/sync-updater.mjs` を実行します。自分のリポジトリで署名配信を始めるときは [移植ガイド](PORTING.md) の `create-update.mjs` を使います。`build-fixtures.mjs` は別の鍵でデモを作り直す旧実験用です。実行すると初期コードと公開鍵も置き換わるため、既存リリースの検証には使えません。

ZIP 処理に fflate 0.8.3 を同梱しています（[MIT ライセンス](extension/vendor/LICENSE.fflate)）。
