# GitHub Releases からの自己更新実験

Windows の Chrome Stable で、開発者モードの拡張機能が GitHub Releases の `latest` を定期確認し、ZIP から取得した `active.js` を自分のフォルダへ書き込んで再読み込みできるかを調べる実験です。外部アップデーターや Native Messaging は使いません。

実機では、画面を閉じた状態でも新リリースの検出・ダウンロード・署名確認・ZIP 展開に成功しました。一方、閉じた後の書き込み権限は `prompt` となり、自動適用は保留されました。画面を開いて `granted` の間は、アラームから書き換え・再読み込みまで進みました。[実測結果](RESULTS.md) を参照してください。

更新の検出・取得と、ディスクへの書き込みは分けています。保存したフォルダハンドルの権限が `granted` の場合だけ自動適用し、`prompt` や `denied` の場合は書き込まず、候補を保存してユーザーの再許可を待ちます。

追加の[権限分離実験](experiments/permission-isolation/README.md)では、別HTTPSページに権限を持たせる方法で、対象拡張機能の再読み込み後も許可を維持できました。「サイトアクセス時は常に許可」の設定後は、Chrome完全再起動後にも再許可せず更新できています。この追加プローブと、ここで説明するGitHub配信処理との統合は未実装です。

## セットアップ

[初期インストール用 ZIP](https://github.com/H4M4CHi-ttr/chrome-unpacked-self-update-lab/releases/latest/download/auto-update-lab.zip) を展開して使えます。ZIP の初期コード版は0.1.0です。フォルダを登録して自動更新を開始すると、公開されている新しい版を取得します。

1. Chrome のプロファイル「AI Agent」で `chrome://extensions` を開き、開発者モードを ON にします。
2. 「パッケージ化されていない拡張機能を読み込む」から `extension` フォルダを読み込みます。
3. 拡張機能の画面で、同じ `extension` フォルダを登録し、読み書きを許可します。
4. 「自動更新を開始」を押します。通常は Chrome 稼働中に5分ごとに確認します。
5. 書き込み権限が失われている場合は「再許可して保留中の更新を適用」を押します。

実機試験で使った一時プロファイルの監視は、試験後に停止しています。公開リポジトリの `latest` は正常版 v0.1.2 に戻し、破損 ZIP の v0.1.3 は検証用の prerelease として残しています。

ポップアップと「独立タブで開く」の両方で同じ状態を扱います。画面の「実行中のコード版」は実際にインポートした `active.js` の版です。manifest の拡張機能版は今回の書き込み対象に含めていません。

## 配信形式

公開リポジトリは `H4M4CHi-ttr/chrome-unpacked-self-update-lab` です。通常リリースのタグを `v0.1.1` の形式にし、次のアセットを配置します。

- `update.json`: リポジトリ、版、固定の更新対象、ZIP とコードのサイズ・SHA-256。
- `update.sig`: `update.json` の生バイト列に対する ECDSA P-256 / SHA-256 の署名。
- `update.zip`: `active.js` だけを格納した ZIP。

拡張機能に同梱した公開鍵で署名を検証し、ZIP のハッシュを確認してから展開します。展開後もファイル名、サイズ、コードのハッシュを照合します。古い版・同じ版、別リポジトリ、パスの変更、追加ファイル、不正な署名やハッシュは適用しません。通信に GitHub のトークンを埋め込みません。

ZIP の上限は128 KiB、JavaScript は16 KiBです。確認には `chrome.alarms` を使います。サービスワーカーの通常のタイマーで監視を続ける実装ではありません。スリープ中の実行時刻や正確な間隔は保証しません。

## 書き込みと復旧

選択先の識別情報と固定ファイルが、Chrome が読み込んでいる拡張機能と一致することを照合します。書き込み対象は既存の `active.js` だけです。ZIP のパスをそのままファイル作成に使いません。

元のコードを IndexedDB へ退避してから、`createWritable()` で置換します。ディスク上の読み返しに加え、自分の `chrome-extension://` URL から取得した内容にも変更が反映されることを確認します。同一内容の別コピーを選んだ場合は、この読み返しが一致しなければ元に戻します。

書き込みや更新記録の保存に失敗した場合は元のコードを復元します。自動復元にも失敗した場合や、新版の起動を確認できない場合は、新しい更新を止めてバックアップを残します。画面の「バックアップの active.js に復元」から再許可して復元できます。バックアップは、新しいサービスワーカーが期待した版とハッシュで起動した後に解除します。

外部エディタや同期ソフトの同時書き込み、ブラウザの保存領域自体の消失には対応しきれません。実験中はコードを並行して編集しないでください。

## 開発用テスト

追加のパッケージインストールやビルドは不要です。Node.js で実行します。

```powershell
node --test tests/lab.test.mjs
```

署名、版・対象・サイズの検証、ZIP の許可ファイル、ハッシュ、フォルダ照合、コピーの検出、書き込み失敗と復元を検証します。ブラウザの権限の保持は実機で別に確認します。

ZIP 処理には、公式 npm 配布物の SHA-512 を確認して取り出した fflate 0.8.3 のブラウザ向けモジュールを使用しています。ライセンスは `extension/vendor/LICENSE.fflate` に同梱しています。

## 実験用リリースの再生成

```powershell
node tools/build-fixtures.mjs <リリースアセットの出力先>
```

このスクリプトは、0.1.0〜0.1.3 の A/B コードと署名付き ZIP を生成します。秘密鍵は非抽出形式のメモリ上に置き、ファイルには保存しません。公開鍵と初期コードは `extension` に書き出します。

再実行すると公開鍵も変わります。以前の拡張機能は新しい鍵の署名を受け入れません。このスクリプトは実験の初期セットを作るためのもので、継続運用する署名鍵の管理や鍵の更新機構は今回実装していません。

## 範囲

更新するのは `active.js` だけです。manifest の変更、複数ファイルの更新、削除、任意の ZIP 展開、Chrome Web Store 向けの配信は対象にしていません。取得した文字列の `eval()` やリモートモジュールのインポートも行いません。

公式資料: [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)、[Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)、[File System Access の権限確認](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access#stored_file_or_directory_handles_and_permissions)。
