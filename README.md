# xserver-wp-deploy

Vite でビルドする WordPress テーマを、**タグを打つだけでエックスサーバーへ反映する**ための一式。

`git clone` してから FTP で `dist/` を手で上げる、という運用をやめるために作った。

---

## 何が問題だったのか

Vite を使う WordPress テーマには、手作業デプロイと相性の悪い性質が3つある。

### 1. `dist/` は Git に入っていない

ビルド成果物なので `.gitignore` している。だからサーバーで `git clone` しても CSS/JS が揃わない。**「clone してから FTP で dist だけ上げる」という二段構えは、この一点から来ている。**

### 2. 壊れても 200 が返る

テーマは `dist/.vite/manifest.json` を読んでアセットの URL を組み立てる。典型的にはこう書く。

```php
function get_vite_asset( $entry ) {
	$manifest = json_decode( file_get_contents( get_template_directory() . '/dist/.vite/manifest.json' ), true );
	if ( ! isset( $manifest[ $entry ] ) ) {
		return '';   // ← 見つからなければ空文字
	}
	return get_template_directory_uri() . '/dist/' . $manifest[ $entry ]['file'];
}

$css = get_vite_asset( 'src/scss/style.scss' );
if ( $css ) {                      // ← 空文字なら enqueue しない
	wp_enqueue_style( 'theme', $css, array(), null );
}
```

manifest が無い・中身が古いと、URL は空文字になり `if` に握り潰される。**PHP エラーは出ず、200 が返り、CSS と JS だけが読まれない「無スタイルのページ」が公開される。** 一番気付きにくい壊れ方をする。

さらに `.vite` は**ドット始まりのディレクトリ**なので、FTP クライアントの隠しファイル設定や `rsync --exclude='.*'` で真っ先に落ちる。

### 3. ファイル名にハッシュが付く

`style-CAh8vfOD.css` のように、ビルドのたびに名前が変わる。だから

- **古いファイルを消さないと**サーバーにゴミが溜まり続ける
- **manifest と assets がズレた瞬間**にサイトが壊れる

手作業だと、この2つを毎回正しくやる必要がある。

---

## どう解決しているか

```
タグ push (v*)  ─┐
手動実行        ─┴→ GitHub Actions（セルフホストランナー / 日本の IP）
                     ↓ npm ci && npm run build      ビルドはここでやる
                     ↓ node scripts/deploy.mjs      SFTP で転送
                     ↓ node scripts/healthcheck.mjs 本当に反映されたか確認
                   エックスサーバー
```

### アップロードの順序で壊れないようにする

これがこのキットの一番の勘所。

```
1. dist 以外すべて（*.php, images/, inc/ ...）
2. dist/assets/ の新しいハッシュ資産
3. dist/.vite/manifest.json     ← ここで新旧が切り替わる
4. 古いファイルの削除
```

2 の時点では新旧のアセットがサーバー上に**併存**していて、稼働中の manifest はまだ旧を指している。3 で manifest を差し替えた瞬間から新を指すが、その実体は既に上がっている。旧アセットを消すのは 4 なので、**「manifest が指すファイルが存在しない」瞬間が構造的に発生しない。**

途中で失敗しても manifest は旧のままなので、サイトは旧アセットで動き続ける。もう一度流せば直る。

### 転送対象は許可リストで決める

除外リストではなく許可リストにしている。

- 除外し忘れ → `src/` や `node_modules/` が本番に露出する（重大）
- 許可し忘れ → 表示が壊れる（気付ける・直せる）

事故ったときの被害が軽い方に倒している。

ルート直下の `.php` は**グロブで拾う**。個別に列挙すると、あとで `front-page.php` を足したときに黙って転送漏れする。

### 転送先ガード

**このスクリプトで一番危険なのは、パスの設定ミスで無関係なディレクトリの中身を削除すること。**

そこで削除に進む前に、転送先の `style.css` を読んで `Theme Name:` が想定のものか照合する。違えば中断する。空のディレクトリへ初めて入れるときだけ `--init` で明示的に飛ばせる。

### ヘルスチェックは HTML の中身まで見る

200 を見るだけでは無スタイルページを検出できない。だから**ローカルの manifest が指すハッシュ付きファイル名が、実際に配信された HTML に現れているか**を照合する。これが一致すれば、manifest と assets が同一ビルドで揃った状態で公開されている証明になる。

---

## なぜセルフホストランナーなのか

エックスサーバーの SSH には制約がある。

| 項目 | 内容 |
|---|---|
| ポート | 10022（22 ではない） |
| 認証 | **公開鍵のみ**（パスワード認証は不可） |
| アクセス制限 | 「国内のみ許可 / すべて許可 / OFF」の3択。**IP ホワイトリストは無い** |

GitHub ホストランナーは国外 IP なので、「国内のみ許可」のままでは接続できない。制限を OFF にしたくない場合、**発信元を日本の IP にする**しかなく、自分の PC をランナーにするのが最も手軽になる。

> 制限を OFF にしてよいなら、`deploy.yml` の `runs-on` を `ubuntu-latest` に変えるだけで GitHub ホストランナーで動く。`defaults.run.shell` の指定も不要になる。

セルフホストランナーは**private リポジトリで使うこと。** public だと fork からの PR で自分の PC 上で任意のコードが実行されうる。

サーバー上でビルドしない理由: エックスサーバーには Node.js が標準で入っておらず、nvm を手で入れることになる。共有ホスティングで壊れやすいので避けている。

---

## 導入手順

### 0. 前提

- Vite でビルドする WordPress テーマ（`dist/.vite/manifest.json` を吐く構成）
- Node.js 22.9 以上
- リポジトリが **private**

### 1. ファイルを配置する

このリポジトリから、テーマのリポジトリ直下へコピーする。

```
scripts/deploy.mjs
scripts/healthcheck.mjs
.github/workflows/deploy.yml
deploy.config.example.json  →  deploy.config.json にリネームして編集
```

`.nvmrc` を作る。

```
22
```

`package.json` に追記する。

```json
{
  "engines": { "node": ">=22.9" },
  "scripts": {
    "deploy": "node --env-file-if-exists=.env scripts/deploy.mjs",
    "deploy:dry": "node --env-file-if-exists=.env scripts/deploy.mjs --dry-run",
    "healthcheck": "node scripts/healthcheck.mjs"
  },
  "devDependencies": { "ssh2-sftp-client": "^12.0.1" }
}
```

```bash
npm install
```

`.gitignore` に `.env` が入っていることを確認する。

### 2. deploy.config.json を書く

```json
{
  "themeMarker": "Theme Name: my-theme",
  "manifest": "dist/.vite/manifest.json",
  "include": {
    "rootGlobs": ["*.php"],
    "rootFiles": ["style.css", "screenshot.png"],
    "dirs": ["inc", "template-parts", "images", "dist"]
  },
  "protected": [".htaccess"],
  "healthcheck": {
    "baseUrl": "https://example.com",
    "themeUrlPath": "/wp-content/themes/my-theme",
    "assetPagePath": "/",
    "pages": [{ "path": "/", "expect": 200 }],
    "notFoundPath": "/__healthcheck-not-found__/",
    "notFoundNeedle": "404 page not found."
  }
}
```

| キー | 意味 |
|---|---|
| `themeMarker` | 転送先ガードで照合する `style.css` 内の文字列 |
| `include` | 転送する対象。**許可リスト** |
| `protected` | リモートにあってもローカルに無いとき、削除しないファイル名 |
| `healthcheck.themeUrlPath` | アセットの URL を組み立てるためのテーマのパス |
| `healthcheck.notFoundNeedle` | `404.php` にしか無い文言。空にするとこのチェックを飛ばす |

転送対象が正しいか、**サーバーに繋がずに**確認できる。

```bash
npm run build
node scripts/deploy.mjs --list
```

### 3. サーバー側の準備

デプロイ先の絶対パスを調べる。**サブドメインは親ドメインの `public_html` 配下**にあることが多いので、思い込みで書かず必ず確認する。

```bash
ssh -p 10022 <サーバーID>@<サーバーID>.xbiz.jp
cd <ドメイン>/public_html/wp-content/themes   # 構成による
pwd
```

**CI 専用の**パスフレーズ無しの鍵を作る。普段使いの鍵からパスフレーズを外すのではなく、専用に分けること。漏洩時にこの鍵だけを失効できる。

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-<プロジェクト名>" -f ~/.ssh/<プロジェクト名>_deploy
```

公開鍵は**追記**する。サーバーパネルから登録すると既存の鍵が置き換わる可能性があり、普段使いの鍵で入れなくなる恐れがある。

```bash
ssh <ホスト> "cat >> ~/.ssh/authorized_keys" < ~/.ssh/<プロジェクト名>_deploy.pub
```

新しい鍵**だけ**で入れることを確かめる。`IdentitiesOnly=yes` が無いと、ssh-agent の別の鍵で通ってしまって検証にならない。

```bash
ssh -i ~/.ssh/<プロジェクト名>_deploy -o IdentitiesOnly=yes -p 10022 <ユーザー>@<ホスト> "echo OK"
```

### 4. GitHub Secrets を登録する

**PowerShell か GitHub の画面から登録すること。Git Bash からは絶対にやらない。**

MSYS のパス変換で `/home/...` が `C:/Program Files/Git/home/...` に書き換わって保存される。実際にこれを踏んだ。

```powershell
gh secret set XSERVER_HOST --body "<サーバーID>.xbiz.jp"
gh secret set XSERVER_USER --body "<サーバーID>"
gh secret set XSERVER_PORT --body "10022"
gh secret set XSERVER_DEPLOY_PATH --body "/home/<サーバーID>/.../wp-content/themes/<テーマ>"
gh secret set XSERVER_SSH_KEY < $HOME\.ssh\<プロジェクト名>_deploy
```

秘密鍵はファイルからリダイレクトで渡す。画面にも履歴にも残らない。

### 5. セルフホストランナーを入れる

**リポジトリの外**に置く。テーマの中に作ると、ランナーが `_work/` にリポジトリを再チェックアウトして入れ子になる。

```powershell
mkdir C:\actions-runner
cd C:\actions-runner
```

`Settings → Actions → Runners → New self-hosted runner` の Download 以降を実行する。`config.cmd` の対話はすべて Enter でよい。ラベルの追加も不要（`self-hosted` `Windows` `X64` が自動で付く）。

サービス化には**管理者権限**が要る。管理者 PowerShell で実行する。

```powershell
$t = gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token
.\config.cmd --url https://github.com/<owner>/<repo> --token $t --runasservice --unattended
```

> Windows 版のランナーに `svc.cmd` は同梱されていない。サービス登録は `config.cmd --runasservice` で行う。既に設定済みの場合は先に `config.cmd remove --token <remove-token>` が要る。

確認する。

```powershell
Get-Service actions.runner.* | Select-Object Name, Status, StartType
```

### 6. 動作確認

**初回は必ずドライランから。** 削除予定に想定外のファイルが無いことを目視する。

```bash
npm run build
npm run deploy:dry
```

空のディレクトリへの初回投入なら `--init` を付ける（転送先ガードを飛ばす）。

```bash
npm run deploy -- --init
```

2回目以降はガードが効くので `--init` は不要。

CI でも流す。Actions 画面から `dry_run: true` で手動実行 → 問題なければ `false` で実行。

---

## 日々の使い方

```bash
# バージョンを上げてタグを打つ → 自動でビルド・転送・検証
git tag -a v1.0.2 -m "v1.0.2"
git push origin v1.0.2
```

Actions 画面からの手動実行もできる。

CI が使えないときはローカルから。

```bash
npm run deploy:dry
npm run deploy
npm run healthcheck
```

`.env` に接続情報を置く。**秘密鍵は書かなくてよい** — `XSERVER_SSH_KEY` が未設定なら ssh-agent を使う。普段 `ssh <ホスト>` で入れているなら鍵は既にエージェントに載っているので、パスフレーズを外した鍵をディスクに置かずに済む。

```
XSERVER_HOST=<サーバーID>.xbiz.jp
XSERVER_USER=<サーバーID>
XSERVER_PORT=10022
XSERVER_DEPLOY_PATH=/home/<サーバーID>/.../wp-content/themes/<テーマ>
```

### フラグ

| フラグ | 意味 |
|---|---|
| `--list` | サーバーに接続せず、転送対象の一覧だけ出して終了 |
| `--dry-run` | 接続はするが書き込まない。転送予定・削除予定を表示 |
| `--init` | 転送先ガードを飛ばす。**空ディレクトリへの初回投入時のみ** |

### ロールバック

前のタグに戻して流し直す。`npm ci` が `package-lock.json` で依存を固定するので、同じタグからは同じ成果物が再現できる。

```bash
git checkout v1.0.1
npm ci && npm run build
npm run deploy
```

---

## 踏んだ落とし穴

実際に構築する過程で出たもの。同じところで詰まらないように残しておく。

| 症状 | 原因 | 対応 |
|---|---|---|
| 全ステップが exit code 1 | サービスの実行アカウント（NETWORK SERVICE）の PowerShell 実行ポリシーが Restricted で、GitHub が生成する `.ps1` を起動できない | `defaults.run.shell: cmd` |
| 「転送先に style.css がありません」 | Git Bash から Secrets を設定し、MSYS のパス変換で `DEPLOY_PATH` が `C:/Program Files/Git/home/...` になっていた | PowerShell から設定し直す |
| `svc.cmd` が無い | Windows 版ランナーには同梱されていない | `config.cmd --runasservice` |
| 差分転送が効かない | `ssh2-sftp-client` に `utimes` が無く、リモートの mtime を合わせられない | 差分判定をやめて毎回全件送る |
| デプロイしたのにサイトが 404 | サブドメインが親ドメインの `public_html` 配下にあり、想定したパスと違った | `pwd` で実パスを確認 |

### 毎回すべて送っている理由

差分だけ送る作りにはしていない。`ssh2-sftp-client` にはリモートの mtime を設定する API が無く、アップロード後の mtime は常に「転送した時刻」になるため、ローカルとの比較が成立しない。

サイズだけの比較に落とすと、**バイト数の変わらない書き換え（1文字の修正など）を無言で取りこぼす。** テーマ規模なら全件でも数十秒なので、その危険を負ってまで短縮する価値がないと判断した。

---

## デプロイでは反映されないもの

テーマのファイルしか転送しない。以下は管理画面側の作業が必要。

- 固定ページの作成と公開
- プラグインの導入と設定（Contact Form 7 のフォーム定義など）
- メニューの割り当て
- 「設定 → プライバシー」などのオプション

**サーバー上で直接編集したファイルは削除される。** ローカルに無いファイルは消す仕様なので、本番を FTP で直接いじる運用が残っているなら注意。

---

## ライセンス

MIT
