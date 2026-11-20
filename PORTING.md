# 自分の拡張機能に移植する

Chrome の開発者モードで配布する拡張機能を対象に、拡張機能の設定タブで選んだフォルダに、書き込み許可が有効な間は新しい GitHub Release を自動適用する構成です。Chrome ウェブストア用の配信には使いません。まず [日本語 README](README.ja.MD) のデモで流れを確認し、その後に下記の設定を差し替えてください。

## 配信するファイルを決める

`tools/build-release.mjs` の `packagePaths` に配信するファイルを登録します。デモでは `active.js` が `version` をエクスポートし、ビルド時に `manifest.json` と同じバージョンになります。GitHub Release のタグもこれに合わせます。

ファイルを追加・削除するときは `packagePaths` に反映します。サービスワーカーは以前から管理しているファイルのうち、新しい一覧から外れたものだけを削除します。元の状態をバックアップし、インストール記録の変更が Chrome にも反映されることを確かめてから対象ファイルを書き換えます。Chrome が新しい manifest とコードで起動したことを確認するまでバックアップを保持します。

## 配信先・設定画面・信頼する鍵を設定する

| 変更箇所 | 設定する値 |
| --- | --- |
| `extension/config.js` | 配信元の `REPOSITORY` と、プライベート配信用の `PRIVATE_REPOSITORY` |
| `extension/manifest.json` | 取得に必要な GitHub ホストと `alarms`、同梱の設定ページを `options_ui` に指定 |
| `extension/popup.html`、`popup.js` | 初回登録、再許可、手動適用、復元の画面。アクションのポップアップと設定タブで共用 |
| `extension/poc-identity.json`、`trust.json` | 移植先の識別情報とリリース署名用の公開鍵 |
| `tools/build-release.mjs` | `packagePaths` に同梱ファイルを登録し、`--refresh-index` でインストール記録を再生成 |

ハンドルと更新中のバックアップは拡張機能の IndexedDB に保存します。ファイル選択と再許可はクリック直後に設定画面から呼びます。サービスワーカーは現在の許可を確認し、書き込めないときは候補を保留します。検証済みの候補と書き込み先は拡張機能内で扱います。外部向けメッセージ受付や、更新設定をホストする Web サイトは不要です。

旧 HTTPS 版からの移行では、旧版の復元作業を終えて監視を停止し、新版を一度手動で読み込んでフォルダを登録します。Chrome のサイト設定で旧サイトへのフォルダ許可を取り消してください。`docs/updater/` は公開済みの旧クライアント専用です。

## プライベートリポジトリを使う場合

1. `REPOSITORY` を対象リポジトリに変更し、`PRIVATE_REPOSITORY` を `true` にしてビルドします。初回の ZIP もアクセスを許可した利用者に配布します。
2. ポップアップの「GitHub アクセストークン（プライベート用）」から GitHub の発行画面を開きます。リポジトリの所有者を選び、`Repository access` の `Only select repositories` で対象リポジトリだけを選びます。`Contents` は `Read-only` にして、有効期限を設定します。組織が承認を求める場合は承認を待ちます。
3. 発行したトークンを拡張機能のポップアップで登録し、「今すぐ確認」を押します。認証エラーや HTTP 404 が出た場合は、期限、対象リポジトリ、読み取り権限、通常リリースの有無を確認します。

トークンは Chrome プロファイル内の拡張機能専用 IndexedDB にリポジトリごとに保存されます。期限が切れたら新しい値を同じ欄で登録できます。ポップアップの「登録を削除」はこの Chrome からの削除です。GitHub 側で失効させるには、GitHub のトークン設定で削除します。

拡張機能のサービスワーカーが GitHub API から最新リリースと署名付きアセットを取得します。トークンを送る宛先は GitHub API です。設定画面は公開版と同じく拡張機能に同梱します。 [トークンの発行手順](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) · [アセット取得に必要な権限](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)

## 初回の ZIP と次版を自分の鍵で署名する

配信者の環境に Node.js 22 以降と P-256 秘密鍵（PEM）を用意します。例として OpenSSL で鍵を生成できます。ユーザーの Chrome で動く更新処理には、これらのコマンドは不要です。

~~~powershell
# 保存先は公開リポジトリ外の、自分だけが読める既存ディレクトリ
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out <秘密ディレクトリ>/updates.pem
node tools/create-update.mjs 1.0.0 extension/active.js <秘密ディレクトリ>/updates.pem <空きパス>/seed
~~~

初回は生成した `trust.json` を `extension` にコピーします。`create-update.mjs` が作るほかのファイルは旧方式用です。パッケージ全体に署名するには `build-release.mjs` を使います。次のリリースでも同じ鍵を使い、配信するバージョンをコマンドに指定します。

~~~powershell
$env:DEMO_SIGNING_KEY_PEM = Get-Content -Raw -LiteralPath '<秘密ディレクトリ>/updates.pem'
try {
  node tools/build-release.mjs 1.1.0 '<空きパス>/v1.1.0'
  if ($LASTEXITCODE -ne 0) { throw 'Release build failed' }
} finally {
  Remove-Item Env:DEMO_SIGNING_KEY_PEM
}
gh release create v1.1.0 '<空きパス>/v1.1.0/auto-update-https.zip' '<空きパス>/v1.1.0/package-update.json' '<空きパス>/v1.1.0/package-update.sig' --latest
~~~

上のコマンドの <> 部分は実際のパスに置き換えてください。アセットをそろえてから通常リリースとして公開します。下書きとプレリリースは latest の対象外です。秘密鍵は配信者が管理し、コミットや公開アセット、エージェントの出力に含めないでください。自分の拡張機能は、自分の公開鍵を固定した初期版から始めます。鍵を切り替えるときは、新しい公開鍵を同梱した ZIP を再配布します。

## cron はデモ専用。移植先は公開する版を明示する

このリポジトリでは、実験用の版を作るため cron-job.org から GitHub Actions を毎時起動します。AI エージェントは、この定期起動や自動の版上げを移植しないでください。運用先では、レビュー済みのタグを作るときや明示的な公開操作を起点に、署名と配信を実行します。拡張機能が Releases を定期確認する処理は移植できます。

## AI エージェントへ渡す依頼の例

> このリポジトリの AGENTS.md と PORTING.md を読み、開発者モードで読み込む私の拡張機能に自動更新を追加してください。既存の権限と配信対象のファイルを調べ、署名とファイルのハッシュを検証してから、初回に私が拡張機能の設定タブで許可したフォルダへ、サービスワーカーから更新を適用してください。許可が必要なときは候補を保留してください。再読み込み後は manifest のバージョンと新版の実行を確認し、途中で止まったらバックアップから復元できるようにしてください。プライベート配信の場合だけ、最小権限のトークンを利用者がポップアップに登録できるようにしてください。毎時リリースの cron は移植せず、既存の公開手順を使ってください。トークンや秘密鍵を表示せず、公開作業は別途指示があるまで行わないでください。未検証の条件も報告してください。

追加の確認先: [Chrome の永続的なファイル権限](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)、[拡張機能のオプションページ](https://developer.chrome.com/docs/extensions/develop/ui/options-page)、[GitHub Releases API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)。
