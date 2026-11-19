# 自分の拡張機能に移植する

Chrome の開発者モードで配布する拡張機能を対象に、初回の許可後は新しい GitHub Release を無操作で適用する構成です。Chrome ウェブストア用の配信には使いません。まず [日本語 README](README.ja.MD) のデモで流れを確認し、その後に下記の設定を差し替えてください。

## 配信するファイルを決める

`tools/build-release.mjs` の `packagePaths` に配信するファイルを登録します。デモでは `active.js` が `version` をエクスポートし、ビルド時に `manifest.json` と同じバージョンになります。GitHub Release のタグもこれに合わせます。

ファイルを追加・削除するときは `packagePaths` に反映します。更新ページは以前から管理しているファイルのうち、新しい一覧から外れたものだけを削除します。元の状態をバックアップし、インストール記録の変更が Chrome にも反映されることを確かめてから対象ファイルを書き換えます。Chrome が新しい manifest とコードで起動したことを確認するまでバックアップを保持します。

## 配信先・更新ページ・信頼する鍵を差し替える

| 変更箇所 | 設定する値 |
| --- | --- |
| extension/config.js の REPOSITORY | 自分の公開 GitHub リポジトリの owner/name |
| extension/bridge.js の UPDATER_URL | 自分が管理する専用 HTTPS オリジンの更新ページ |
| extension/manifest.json | ページのオリジンを host_permissions、ページの URL パターンを externally_connectable.matches に反映 |
| extension/poc-identity.json | 移植先固有の識別情報 |
| extension/trust.json | 自分のリリース署名用の公開鍵 |
| extension/install.json | 配信ファイルのハッシュを記したインストール記録。配布 ZIP にはビルド時に生成される |
| docs/updater | 自分の HTTPS オリジンへ配置。ページが参照する CSS も同梱。設定変更後に node tools/sync-updater.mjs を実行 |

オリジンとは、プロトコル・ホスト名・ポートの組み合わせです。Chrome のフォルダ許可はオリジン単位です。同じホスト上の別ページも同じ権限の境界に入るため、実運用では更新専用のホストを使い、第三者の埋め込みやスクリプトは避けてください。リリース署名が保護するのは配信物です。HTTPS ページ自体が改ざんされた場合のファイル操作も署名で防げる、とは考えないでください。この公開デモには検証専用フォルダだけを登録してください。

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

このリポジトリの毎時の GitHub Actions は、実験用の版を作り続けるためにあります。AI エージェントはこの cron や自動の版上げを移植しないでください。運用先では、レビュー済みのタグを作るときや明示的な公開操作を起点に、署名と配信を実行します。拡張機能が Releases を定期確認する処理は移植できます。

## AI エージェントへ渡す依頼の例

> このリポジトリの AGENTS.md と PORTING.md を読み、開発者モードで読み込む私の拡張機能に自動更新を追加してください。既存の権限と配信対象のファイルを調べ、署名とファイルのハッシュを検証してから、初回に私が許可した専用 HTTPS ページで更新してください。再読み込み後は manifest のバージョンと新版の実行を確認し、途中で止まったらバックアップから復元できるようにしてください。毎時リリースの cron は移植せず、既存の公開手順を使ってください。秘密鍵を表示せず、公開作業は別途指示があるまで行わないでください。未検証の条件も報告してください。

追加の確認先: [Chrome の永続的なファイル権限](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)、[外部ページからのメッセージ](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#external-webpage)、[GitHub Releases API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)。
