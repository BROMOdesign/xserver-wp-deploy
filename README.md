# xserver-wp-deploy

ビルドを伴う WordPress テーマを、**タグを打つだけでエックスサーバーへ反映する**ための一式。

`git clone` してから FTP でビルド成果物を手で上げる、という運用をやめるために作った。

ビルド成果物の指定方法が2つある。**Vite** なら `manifest`（`dist/.vite/manifest.json`）を、**sass CLI のように固定パスへ吐くビルド**なら `assets`（`["src/css/style.min.css"]` など）を指定する。以降の説明は主に manifest モードを例にしているが、assets モードでも手順は同じで、違いは「配信されている成果物が今回のビルドかをどう確かめるか」だけ。→ [固定パスのビルド（assets モード）](#固定パスのビルドassets-モード)

案件のリポジトリからは **npm の依存として入れ、CI は再利用可能ワークフローとして呼ぶ**。案件側に置くのは `deploy.config.json` と10行のワークフローだけで、修正はタグを追えば全案件に届く。

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
                     ↓ npm ci && npm run build   ビルドはここでやる
                     ↓ npx xwp-deploy            SFTP で転送
                     ↓ npx xwp-healthcheck       本当に反映されたか確認
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

「重大」の方は絵空事ではない。手上げ運用だった既存サイトにこのキットを入れたとき、ドライランの削除予定に `.git/` が 165 ファイル並んだ。テーマディレクトリごと FTP で上げていたため、**`https://<ドメイン>/wp-content/themes/<テーマ>/.git/config` が 200 を返す状態**になっていた。private リポジトリのソースと全コミット履歴が web から復元できる。`src/` も `package.json` も同じく読めた。

`.git/` を上げないよう気をつける、では防げない。**上げるものを列挙する**方式でしか防げない類の事故だと考えている。

ルート直下の `.php` は**グロブで拾う**。個別に列挙すると、あとで `front-page.php` を足したときに黙って転送漏れする。

### 転送先ガード

**このスクリプトで一番危険なのは、パスの設定ミスで無関係なディレクトリの中身を削除すること。**

そこで削除に進む前に、転送先の `style.css` を読んで `Theme Name:` が想定のものか照合する。違えば中断する。空のディレクトリへ初めて入れるときだけ `--init` で明示的に飛ばせる。

### ヘルスチェックは HTML の中身まで見る

200 を見るだけでは無スタイルページを検出できない。だから**ローカルの manifest が指すハッシュ付きファイル名が、実際に配信された HTML に現れているか**を照合する。これが一致すれば、manifest と assets が同一ビルドで揃った状態で公開されている証明になる。

ただし **manifest の全エントリが1ページの HTML に出るとは限らない。** ページ別にしか enqueue されない JS（施工事例用・用語集用など）や、HTML ではなく CSS から参照される背景画像は、正常でも現れない。これを一律に必須とすると毎回のデプロイが赤くなる。

そこで `healthcheck.htmlAssets` に「そのページに必ず出るエントリ」を列挙できる。指定するとそれだけが必須になり、残りは実体が取得できるかだけ見る。省略時は従来どおり全件必須なので、既存の設定はそのまま動く。

許可リストなので「書き忘れると検査されない」弱点がある。これは2つの検査で潰してある。**manifest に無いキーを書いたらエラー**にし、**必須対象が0件になってもエラー**にする。タイポが黙って検査を素通りさせることはない。

---

## 固定パスのビルド（assets モード）

Vite を使わないテーマもある。`sass src/scss/style.scss src/css/style.min.css` のように**決まった名前で吐くビルド**がそれで、その場合は `manifest` の代わりに `assets` へ成果物のパスを並べる。

```json
{
  "assets": ["src/css/style.min.css"]
}
```

`manifest` と `assets` は排他で、どちらか一方が必須。両方書くとエラーになる。

### manifest モードとの違いは検査の仕方だけ

上に書いた「壊れても 200 が返る」は **Vite 固有の壊れ方**で、assets モードには起きない。テーマが `get_vite_asset()` の空文字を握り潰すから無言で無スタイルになるのであって、URL が固定パスなら成果物が落ちていれば素直に 404 になるからだ。**無い病気の薬は要らない。**

代わりに assets モードには別の弱点がある。**ファイル名が新旧で同じ**なので、「HTML に出ているか」「200 が返るか」をいくら見ても、前回のビルドが残ったままなのを見抜けない。ハッシュ付きの名前が担保してくれていたものが無い。

そこで**配信された中身の sha256 をローカルのビルド成果物と突き合わせる。** 名前で担保できないものを中身で担保する。バイト数が偶然一致する書き換えも取りこぼさない。

食い違ったときはエックスサーバーのエッジキャッシュが直前の内容を返しているだけのことがあるので、5秒間隔で3回まで取り直してから落とす。それでも合わなければ両方のハッシュを出して失敗させる。

### キャッシュバスターは自分で用意する

ハッシュ付きファイル名が無いということは、**ブラウザキャッシュを外す仕組みも無い**ということ。`wp_enqueue_style()` の第4引数にバージョンを直書きしていると、デプロイしても閲覧者には古い CSS が出続ける。`filemtime()` を使う。

```php
wp_enqueue_style(
	'theme-style',
	get_theme_file_uri() . '/src/css/style.min.css',
	array(),
	filemtime( get_theme_file_path() . '/src/css/style.min.css' )
);
```

### ビルド成果物は .gitignore したままにする

`assets` に挙げたパスは、**checkout 直後には存在しない**のが正しい状態。ランナーが `npm run build` して初めて生まれる。だから「そこにあるか」の検査がそのまま「ビルドが走ったか」の検査になる。成果物をコミットしてしまうとこの保証が消える。

### ソースマップを本番に出さない

sass CLI は既定でソースマップを吐く。`src/css` を丸ごと転送すると `style.min.css.map` も一緒に上がり、**SCSS のソースが本番から読める。** ビルドコマンドに `--no-source-map` を付ける。

---

## なぜセルフホストランナーなのか

エックスサーバーの SSH には制約がある。

| 項目 | 内容 |
|---|---|
| ポート | 10022（22 ではない） |
| 認証 | **公開鍵のみ**（パスワード認証は不可） |
| アクセス制限 | 「国内のみ許可 / すべて許可 / OFF」の3択。**IP ホワイトリストは無い** |

GitHub ホストランナーは国外 IP なので、「国内のみ許可」のままでは接続できない。制限を OFF にしたくない場合、**発信元を日本の IP にする**しかなく、自分の PC をランナーにするのが最も手軽になる。

> 制限を OFF にしてよいなら GitHub ホストランナーで動かせる。呼び出し側から `runner_labels: '["ubuntu-latest"]'` を渡すことになるが、キット側の `defaults.run.shell: cmd` が Windows 前提なので、そこも外す必要がある。ランナーが使い捨てになるので、`setup-node` に `cache: npm` を戻したほうがよい（セルフホストでは不要なので外している）。

セルフホストランナーは**private リポジトリで使うこと。** public だと fork からの PR で自分の PC 上で任意のコードが実行されうる。

これは**案件（テーマ）側のリポジトリの話**。このキット本体は public だが、持っているワークフローは `workflow_call` だけで単体では起動できず、ランナーも登録されていないので該当しない。

サーバー上でビルドしない理由: エックスサーバーには Node.js が標準で入っておらず、nvm を手で入れることになる。共有ホスティングで壊れやすいので避けている。

---

## 導入手順

### 0. 前提

- ビルドを伴う WordPress テーマ。次のどちらか
  - **Vite**（`dist/.vite/manifest.json` を吐く構成）→ `manifest` を指定する
  - **固定パスに吐くビルド**（sass CLI など）→ `assets` を指定する（[assets モード](#固定パスのビルドassets-モード)）
- Node.js 22.9 以上
- リポジトリが **private**
- `gh` CLI が認証済み（Secrets 登録とランナー導入に使う）

### 1. キットを入れる

テーマのリポジトリで実行する。**tarball の URL で入れること。**

```bash
npm i -D https://github.com/BROMOdesign/xserver-wp-deploy/archive/refs/tags/v1.1.1.tar.gz
```

`npm i -D github:BROMOdesign/xserver-wp-deploy#v1` と書いてはいけない。npm が
hosted-git-info で正規化するため、`package-lock.json` の `resolved` が
`git+ssh://` になる。

```
"resolved": "git+ssh://git@github.com/BROMOdesign/xserver-wp-deploy.git#afcd46a"
```

CI の `npm ci` はこの URL で取りに行くので、**ランナーのサービスアカウント
（NETWORK SERVICE）から github.com へ SSH できる必要が出てくる。** 手順5の
ランナー導入はその鍵を用意しないため、キットが public であること（＝認証が
要らないこと）の利点がここで失われる。`git+https://` と書いても同じ形に
正規化されるので回避できない。

tarball URL なら匿名の HTTPS GET で取れ、git も認証も要らない。lock に
integrity ハッシュが載るので `npm ci` は完全に再現する。

```
"resolved": "https://github.com/.../archive/refs/tags/v1.1.1.tar.gz",
"integrity": "sha512-nh61D+YySEGcNgN/B3K8CTVe4wqHkbWAVrm1..."
```

代償として `v1` の移動タグには追従せず、更新はこの URL のバージョンを上げる
明示的な操作になる。**ただし移動タグが本当に効いてほしいのは再利用ワーク
フローの方**で、そちらは `uses: ...@v1` が追い続けるので意図は保たれる。
スクリプトが黙って入れ替わらない分、むしろ挙動を追いやすい。

`package.json` に追記する。npm スクリプトからは `node_modules/.bin` に PATH が通るので、コマンド名をそのまま書ける。

```json
{
  "engines": { "node": ">=22.9" },
  "scripts": {
    "deploy": "xwp-deploy",
    "deploy:dry": "xwp-deploy --dry-run",
    "healthcheck": "xwp-healthcheck"
  }
}
```

`ssh2-sftp-client` はキット側の依存なので書かなくてよい。

`.nvmrc` を作る。

```
22
```

`deploy.config.json` を作る（次項）。雛形はここにある。

```bash
cp node_modules/@bromodesign/xserver-wp-deploy/deploy.config.example.json deploy.config.json
```

ワークフローを置く。**中身はキット側にあるので、案件側はこの呼び出しだけ**になる。

`.github/workflows/deploy.yml`:

```yaml
name: Deploy to production

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'ドライラン（転送せず差分だけ表示する）'
        type: boolean
        default: false

jobs:
  deploy:
    uses: BROMOdesign/xserver-wp-deploy/.github/workflows/deploy.yml@v1
    with:
      dry_run: ${{ inputs.dry_run || false }}
    # secrets: inherit は使わない。呼び出し元とこのキットの owner が違う場合
    # （例 corp-bromo-web の案件から BROMOdesign のキットを呼ぶ）、inherit では
    # 鍵が空のまま渡り、スクリプトが ssh-agent へフォールバックして
    # 「All configured authentication methods failed」で落ちる。
    # 明示的に渡せば owner の関係に依存しない。
    secrets:
      XSERVER_SSH_KEY: ${{ secrets.XSERVER_SSH_KEY }}
      # 接続情報も Secrets 側に置いている案件だけ、以下も渡す
      # XSERVER_HOST: ${{ secrets.XSERVER_HOST }}
      # XSERVER_USER: ${{ secrets.XSERVER_USER }}
      # XSERVER_PORT: ${{ secrets.XSERVER_PORT }}
      # XSERVER_DEPLOY_PATH: ${{ secrets.XSERVER_DEPLOY_PATH }}
```

同じものがキットのリポジトリの `examples/caller-workflow.yml` にも置いてある。

**`secrets: inherit` と書いてはいけない。** 案件リポジトリとこのキットの owner が違うと（例: `corp-bromo-web` の案件から `BROMOdesign` のキットを呼ぶ）、`inherit` では鍵が空のまま渡る。スクリプトは `XSERVER_SSH_KEY` が無ければ ssh-agent へフォールバックする作りなので、ランナーのサービスアカウント（NETWORK SERVICE）にエージェントが無く、こう落ちる。

```
認証:       ssh-agent（\\.\pipe\openssh-ssh-agent）

✗ getConnection: All configured authentication methods failed
```

**Secrets は正しく登録されているのにこのエラーが出る** ので、鍵や登録方法を疑って時間を溶かしやすい。ログの「認証:」の行が `秘密鍵（XSERVER_SSH_KEY）` になっているかで切り分けられる。

キットのリポジトリは public なので、案件リポジトリが private でも認証は要らない。`npm ci` も `uses:` もそのまま通る。

### 2. deploy.config.json を書く

```json
{
  "themeMarker": "Theme Name: my-theme",
  "manifest": "dist/.vite/manifest.json",
  "server": {
    "host": "<サーバーID>.xbiz.jp",
    "user": "<サーバーID>",
    "port": 10022,
    "deployPath": "/home/<サーバーID>/<ドメイン>/public_html/wp-content/themes/my-theme"
  },
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
| `manifest` | Vite の manifest のパス。`assets` と排他でどちらか必須 |
| `assets` | 固定パスに吐くビルドの成果物パス（テーマルート相対）の配列。`manifest` と排他でどちらか必須 |
| `server` | 接続情報。**秘密なのは鍵だけ**なので private リポジトリならここに書く。環境変数（`XSERVER_HOST` など）を設定した場合はそちらが優先される |
| `include` | 転送する対象。**許可リスト** |
| `protected` | リモートにあってもローカルに無いとき、削除しないファイル名 |
| `healthcheck.themeUrlPath` | アセットの URL を組み立てるためのテーマのパス |
| `healthcheck.htmlAssets` | `assetPagePath` の HTML に必ず現れるべき manifest のキー。省略すると manifest の全エントリが必須。**manifest モードのみ** |
| `healthcheck.notFoundNeedle` | `404.php` にしか無い文言。空にするとこのチェックを飛ばす |

転送対象が正しいか、**サーバーに繋がずに**確認できる。

```bash
npm run build
npx xwp-deploy --list
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

**これは bash で実行すること。** PowerShell から同じ行を打つと `-N ""` の引数展開でリテラルの `""` 2文字がパスフレーズになる。鍵は一見できているのに CI から使えず、原因が見えにくい。踏んでしまったら作り直さなくてよい。パスフレーズだけ外せる。

```bash
ssh-keygen -p -P '""' -N '' -f ~/.ssh/<プロジェクト名>_deploy
```

パスフレーズが付いているかは、暗号化されているとヘッダ直後が `aes256-ctr` になることで見分けられる（付いていなければ `none`）。

公開鍵は**追記**する。サーバーパネルから登録すると既存の鍵が置き換わる可能性があり、普段使いの鍵で入れなくなる恐れがある。

```bash
ssh <ホスト> "cat >> ~/.ssh/authorized_keys" < ~/.ssh/<プロジェクト名>_deploy.pub
```

新しい鍵**だけ**で入れることを確かめる。`IdentitiesOnly=yes` が無いと、ssh-agent の別の鍵で通ってしまって検証にならない。

```bash
ssh -i ~/.ssh/<プロジェクト名>_deploy -o IdentitiesOnly=yes -p 10022 <ユーザー>@<ホスト> "echo OK"
```

### 4. GitHub Secrets を登録する

`server` を `deploy.config.json` に書いたなら、**登録するのは秘密鍵だけ**でいい。

```powershell
Get-Content -Raw $HOME\.ssh\xserver_deploy | gh secret set XSERVER_SSH_KEY --repo <owner>/<repo>
```

秘密鍵は標準入力で渡す。値が argv に載らないので、画面にも履歴にもプロセス一覧にも残らない。

`-Raw` を付けないと1行ずつの配列として渡り、鍵の改行が壊れる。**`<` によるリダイレクトは使えない**（PowerShell では `<` が予約演算子で `ParserError` になる）。

**鍵は案件ごとに分けなくてよい。** 同じサーバーアカウントなら、どの鍵でも全ドメインの `public_html` に届く。分けたところで漏洩時の被害範囲は変わらず、ローテートのときに全案件を直す手間だけが増える。

接続情報を設定ファイルに置きたくないなら、従来どおり Secrets に入れてもよい。環境変数のほうが `deploy.config.json` の `server` より優先される。

```powershell
gh secret set XSERVER_HOST --body "<サーバーID>.xbiz.jp"
gh secret set XSERVER_USER --body "<サーバーID>"
gh secret set XSERVER_PORT --body "10022"
gh secret set XSERVER_DEPLOY_PATH --body "/home/<サーバーID>/.../wp-content/themes/<テーマ>"
```

**その場合は PowerShell か GitHub の画面から登録すること。Git Bash からは絶対にやらない。** MSYS のパス変換で `/home/...` が `C:/Program Files/Git/home/...` に書き換わって保存され、転送先ガードで弾かれる。実際にこれを踏んだ。

### 5. セルフホストランナーを入れる

**管理者 PowerShell** で、キットに入っているスクリプトを流す。ダウンロード・展開・登録・サービス化までやる（`gh` が認証済みであること）。

```powershell
.\node_modules\@bromodesign\xserver-wp-deploy\scripts\setup-runner.ps1 -Repo <owner>/<repo>
```

ランナーの登録スコープは「リポジトリ / Organization / Enterprise のいずれか1つ」で、**個人（User）アカウントに Organization スコープは無い**。つまり**案件ごとに1インストールが必須**で、これは減らせない。減らせないので代わりに丸ごとスクリプトにした。

スクリプトが面倒を見ているもの。上の4つはいずれも実際に踏んだ。

- **ディレクトリ名にリポジトリ名が入る。** 固定名にすると2案件目で必ず衝突する
- **`C:\actions-runner-<リポジトリ名>` はリポジトリの外に作る。** テーマの中に作ると、ランナーが `_work/` にリポジトリを再チェックアウトして入れ子になる
- **既存のランナーの配下に展開しない。** `C:\actions-runner\actions-runner` になると、親を消したときに中のランナーも巻き添えで消える
- **管理者権限が無ければ最初に止まる。** 権限なしで `config.cmd` を走らせると、登録だけ済んでサービス化で失敗し、入れ直そうにも `already configured` で弾かれる
- **同じ親ディレクトリに zip があれば使い回す。** 2案件目以降のダウンロードを省ける

手でやる場合は `Settings → Actions → Runners → New self-hosted runner` の Download 以降を実行する。`config.cmd` の対話はすべて Enter でよい。ラベルの追加も不要（`self-hosted` `Windows` `X64` が自動で付く）。サービス化には**管理者権限**が要る。

```powershell
$t = gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token
.\config.cmd --url https://github.com/<owner>/<repo> --token $t --runasservice --unattended
```

> Windows 版のランナーに `svc.cmd` は同梱されていない。サービス登録は `config.cmd --runasservice` で行う。既に設定済みの場合は先に `config.cmd remove --token <remove-token>` が要る。

確認する。

```powershell
Get-Service actions.runner.* | Select-Object Name, Status, StartType
```

#### 2つ目以降のサイトを同じ PC で回す

ランナーの登録は**リポジトリ単位**なので、2サイト目には2台目のインスタンスが要る。1台の PC に何台でも入れられる。案件ごとに `setup-runner.ps1` を流せばよく、ディレクトリの分離も zip の使い回しもスクリプトが面倒を見る。

`Organization` アカウントなら Organization ランナーにして複数リポジトリで共有できるが、**個人（User）アカウントにこの機能は無い**。owner の種別は `gh api users/<owner> --jq .type` で分かる。

インスタンスごとに別サービスとして常駐する。ラベルは全台同じ（`self-hosted` `Windows` `X64`）だが、ランナーは自分が登録されたリポジトリのジョブしか拾わないので混線しない。

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

> **サーバーに `git clone` 済みの環境へ初めて入れる場合、初回だけ極端に重くなる。**
> 許可リストに無いものはすべて削除対象になるため、`.git` / `sample` / `node_modules` が
> 残っていると削除が数千件に達する（実例: **7,799 件**）。SFTP の逐次削除は遅く、
> **`deploy.yml` の `timeout-minutes: 15` を超えうる。**
>
> **初回はローカルから `npm run deploy` を流す**（タイムアウトが無い）。
> 先に SSH で `rm -rf` して不要物を落としておくとさらに速い。
>
> **デプロイを並走させないこと。** 同じファイルを削除し合って両方失敗する。
> CI 側は `concurrency` で制御しているが、ローカル実行と CI を同時に走らせると起きる。

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

接続情報は `deploy.config.json` の `server` から読むので、**ローカルに `.env` は要らない**。秘密鍵も書かなくてよい — `XSERVER_SSH_KEY` が未設定なら ssh-agent を使う。普段 `ssh <ホスト>` で入れているなら鍵は既にエージェントに載っているので、パスフレーズを外した鍵をディスクに置かずに済む。

接続情報を Secrets 側に置いている案件だけ、ローカル用に `.env` を作る。読み込むには `--env-file-if-exists` を付けて実体を直接呼ぶ（`node_modules/.bin` のラッパーは Node のフラグを受け取れない）。

```json
"deploy": "node --env-file-if-exists=.env node_modules/@bromodesign/xserver-wp-deploy/scripts/deploy.mjs"
```

```
XSERVER_HOST=<サーバーID>.xbiz.jp
XSERVER_USER=<サーバーID>
XSERVER_PORT=10022
XSERVER_DEPLOY_PATH=/home/<サーバーID>/.../wp-content/themes/<テーマ>
```

`.gitignore` に `.env` が入っていることを確認する。

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

## 2案件目以降

案件ごとに要るのはこれだけ。

| 作業 | やること |
|---|---|
| キットを入れる | `npm i -D https://github.com/BROMOdesign/xserver-wp-deploy/archive/refs/tags/<version>.tar.gz`（**`github:` 短縮形は使わない**） |
| 設定を書く | `deploy.config.json`（`server` を含む） |
| ワークフローを置く | `examples/caller-workflow.yml` をコピー |
| 鍵を登録する | `gh secret set XSERVER_SSH_KEY --repo <owner>/<repo>` |
| ランナーを入れる | `setup-runner.ps1 -Repo <owner>/<repo>`（管理者 PowerShell） |

**CI が要らない案件ならランナーは省ける。** スクリプトは ssh-agent 経由の認証に対応しているので、ローカルから `npm run deploy` だけで完結する。「タグを打ったら自動」が欲しい案件にだけ入れればよい。

### キットを更新する

案件側は `@v1` を参照している。キットに修正を入れたら、`v1` タグを新しいコミットへ移す。

```bash
git tag -a v1.0.1 -m "v1.0.1"
git tag -f v1 v1.0.1
git push origin v1.0.1
git push -f origin v1
```

ワークフロー側は次の実行から新しい `v1` を拾う。**スクリプト側は tarball の URL を固定しているので自動では追従しない。** 案件ごとに `package.json` の URL のバージョンを上げて `npm i` を流す。

> **タグを打つ前に、この README の導入 URL（手順1）を新しいバージョンへ上げること。**
> README はタグの中身として配布されるため、`v1.1.1` の中の README が `v1.1.0` を
> 指していると、そのバージョンを見て入れた新規案件が古い版を掴む。
> バージョン更新のコミットに含めてしまうのが確実。

**壊れる変更を入れるときは `v1` を動かさない。** `v2` を切って、案件ごとに参照を上げる。

---

## 踏んだ落とし穴

実際に構築する過程で出たもの。同じところで詰まらないように残しておく。

| 症状 | 原因 | 対応 |
|---|---|---|
| 全ステップが exit code 1 | サービスの実行アカウント（NETWORK SERVICE）の PowerShell 実行ポリシーが Restricted で、GitHub が生成する `.ps1` を起動できない | `defaults.run.shell: cmd` |
| 「転送先に style.css がありません」 | Git Bash から Secrets を設定し、MSYS のパス変換で `DEPLOY_PATH` が `C:/Program Files/Git/home/...` になっていた | PowerShell から設定し直す |
| `svc.cmd` が無い | Windows 版ランナーには同梱されていない | `config.cmd --runasservice` |
| 差分転送が効かない | `ssh2-sftp-client` に `utimes` が無く、リモートの mtime を合わせられない | 差分判定をやめて毎回全件送る |
| 削除フェーズで `✗ delete: No such file` | 削除一覧を作ってから実際に消すまでの間に、対象が別プロセスや手作業で消えていた | `SSH_FX_NO_SUCH_FILE` は無視して続行する |
| デプロイしたのにサイトが 404 | サブドメインが親ドメインの `public_html` 配下にあり、想定したパスと違った | `pwd` で実パスを確認 |
| 毎回 `Failed to save: "C:\Program failed` の警告が出る | `cache: npm` が PATH 上で先に見つかる Git の `tar.exe` を、パス中のスペースごと渡してしまう | `cache: npm` を外す。セルフホストランナーなら `~/.npm` が残るので元から不要 |
| `config.cmd --runasservice` が「Needs Administrator privileges」で止まる | 管理者権限なしで実行した。**ランナー登録自体は済んでいる**ため、入れ直そうとしても `already configured` で弾かれる | 管理者 PowerShell で `config.cmd remove --token <remove-token>` してから再設定 |
| Secrets は登録済みなのに `All configured authentication methods failed` | 案件とキットの owner が違い、`secrets: inherit` では鍵が空のまま渡っていた。スクリプトが ssh-agent にフォールバックし、NETWORK SERVICE にエージェントが無いので失敗する | 呼び出し側で `secrets: XSERVER_SSH_KEY: ${{ secrets.XSERVER_SSH_KEY }}` と明示的に渡す。ログの「認証:」行で切り分けられる |
| 作った CI 専用鍵で入れない | PowerShell から `ssh-keygen -N ""` を実行し、リテラルの `""` がパスフレーズになっていた | `ssh-keygen -p -P '""' -N '' -f <鍵>` で外す。鍵の作り直しは不要 |
| デプロイ直後だけ古い画像が返る | エックスサーバーのエッジキャッシュ。サーバー上の実ファイルは新しい | 数十秒待つか `?v=<何か>` を付けて確認する。実体は `ssh` で `ls -l` すれば確かめられる |

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
