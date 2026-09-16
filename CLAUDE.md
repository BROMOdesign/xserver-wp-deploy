# CLAUDE.md

> 作業を再開するときは、まず `HANDOVER.md`（前回のセッションの状況と次の一手）を読むこと。

## このリポジトリは何か

エックスサーバーへ WordPress テーマを転送・検証する**デプロイキット本体**。案件（テーマ）のリポジトリではない。

`.github/workflows/deploy.yml` は `on: workflow_call` しか持たず、**このリポジトリ単体では発火しない。** 案件側が `uses: BROMOdesign/xserver-wp-deploy/.github/workflows/deploy.yml@v1` で呼ぶ。セルフホストランナーも登録されていない。

配布物は次の3つ。`package.json` の `files` と `bin` がその定義。

| 実体 | 役割 |
|---|---|
| `scripts/deploy.mjs` | `xwp-deploy`。許可リスト方式で SFTP 転送する |
| `scripts/healthcheck.mjs` | `xwp-healthcheck`。配信された中身まで検証する |
| `scripts/setup-runner.ps1` | セルフホストランナーの導入を1コマンドにする |

`README.md` は**利用者向けドキュメントであると同時に配布物**。タグの中身として案件に届く。この CLAUDE.md は保守者向けで、配布はされるが利用者は読まない。**手順を両方に書かない**（README が正）。

## 絶対規則 — 案件名を書かない

このリポジトリは **public**。案件名・クライアント名を README・コミットメッセージ・PR 本文・PR コメントのいずれにも書かない。

一度 push すると PR の `refs/pull/*` に残り、**force push でも PR 本文の編集でも消せない**（編集履歴が残る）。2026-09-02 のリポジトリ分割も、2026-09-16 の作り直しも原因はこれ。

`.githooks/` がそれを機械的に弾く。**clone ごとに1度だけ有効化が要る。**

```bash
git config core.hooksPath .githooks
```

禁止語のリストはこのリポジトリには置かない（置いたら本末転倒）。`~/.config/git/private-names.txt` に1行1パターン。ファイルが無ければフックは素通りするので、**有効化した気になっていても効いていないことがある。**

## リポジトリ構成

| リポジトリ | 可視性 | 中身 |
|---|---|---|
| `BROMOdesign/xserver-wp-deploy` | public | これ。配布用。案件はここを `@v1` で参照する |
| `BROMOdesign/xserver-wp-deploy-private` | private | 分割前の履歴と検討資料。ローカルの remote 名 `archive` |
| `BROMOdesign/xserver-wp-deploy-public-archive` | private | 初代の公開リポを改名して private 化したもの |

案件に紐づく導入記録・実数値は、このリポジトリではなく Google ドキュメントに書く。

## リリース手順

案件側は `@v1` を参照しているので、修正を入れたら `v1` を新しいコミットへ移す。

```bash
git tag -a v1.0.1 -m "v1.0.1"
git tag -f v1 v1.0.1
git push origin v1.0.1
git push -f origin v1
```

**タグを打つ前に README の導入 URL（手順1）のバージョンを上げること。** README はタグの中身として配布されるため、`v1.1.1` の中の README が `v1.1.0` を指していると、それを見た新規案件が古い版を掴む。バージョン更新のコミットに含めてしまうのが確実。

**壊れる変更のときは `v1` を動かさない。** `v2` を切って案件ごとに参照を上げる。

### 案件側の参照経路は2系統あり、追従の仕方が違う

| 経路 | 書き方 | `v1` への追従 |
|---|---|---|
| ワークフロー | `uses: ...@v1` | **する。** GitHub がサーバー側で解決する |
| スクリプト | `npm i -D .../archive/refs/tags/v1.1.1.tar.gz` | **しない。** URL が固定。案件ごとに上げて `npm i` |

`npm i -D github:BROMOdesign/xserver-wp-deploy#v1` と書いてはいけない。npm が `git+ssh://` に正規化し、ランナーのサービスアカウントから github.com への SSH が必要になって、public にした意味が消える。

### ★ 履歴を書き換えると、配布済みの案件の `npm ci` が壊れる

GitHub の source tarball は先頭に `pax_global_header` を持ち、`git archive` がそこに
**コミット SHA を書き込む**。つまり **tree が同一でもコミット SHA が変われば tarball の
バイト列が変わり、sha512 が変わる。**

案件側の `package-lock.json` は tarball の `integrity` を固定しているので、`npm ci` が
`EINTEGRITY` で落ちる。2026-09-16 の履歴書き換え（`git filter-repo`）で実際にそうなった。

| タグ | 書き換え前の integrity（案件の lock） | 書き換え後の実測 |
|---|---|---|
| `v1.1.0` | `sha512-nh61D+...` | `sha512-HDwkKq...` → **不一致** |

**履歴を書き換えたら、既にキットを入れている案件すべてで `npm i` を流し直す**（lock の
`integrity` を更新する）必要がある。「tree が同じだから tarball も同じ」は成り立たない。

#### ★ ただし、すぐには落ちない。時限式であることが本当の罠

**npm のローカルキャッシュに旧 tarball が残っている間は `npm ci` が通ってしまう。**
壊れているのに緑のまま進むので、気付く機会が無い。

| 条件 | 結果 |
|---|---|
| キャッシュあり（`~/.npm` に旧 tarball が残っている） | **通る。** 壊れていることが見えない |
| キャッシュなし（`npm ci --cache <空ディレクトリ>`） | `EINTEGRITY` で落ちる |

セルフホストランナーは `~/.npm` を持ち越すので、**CI もしばらく通り続ける。**
キャッシュが消えた日に、履歴書き換えとは無関係に見える障害として噴き出す。

**壊れているかどうかは `npm ci` の成否では判定できない。** 次のどちらかで確かめる。

```bash
# 1. lock の integrity と実体を直接照合する
curl -sSL -o /tmp/kit.tar.gz https://github.com/BROMOdesign/xserver-wp-deploy/archive/refs/tags/<tag>.tar.gz
openssl dgst -sha512 -binary /tmp/kit.tar.gz | openssl base64 -A   # lock の integrity と比べる

# 2. 空のキャッシュで npm ci を流す
npm ci --cache "$(mktemp -d)"
```

---
## この環境固有の落とし穴

- **Git Bash から `gh secret set` でパスを渡さない。** MSYS のパス変換で `/home/...` が `C:/Program Files/Git/home/...` に書き換わって保存される。PowerShell か GitHub の画面から
- **`ssh-keygen -N ""` は bash で打つ。** PowerShell だとリテラルの `""` 2文字がパスフレーズになる
- **`grep -v` の除外パターンには `-E` を付ける。** BRE では `\+` が繰り返し演算子になり、`^\+\+\+` を除くつもりが全行を捨てる（`.githooks/pre-commit` で実際に踏んだ）
- ファイルは **CRLF**。`python` で文字列置換するときは `newline=""` で読んで改行コードを合わせる
- 本番サーバーへの SSH や private リポジトリのファイル読み取りは、自動承認で止まることがある

## 検証できないことの範囲

- **実デプロイはこのリポジトリ単体では試せない。** 案件リポジトリから呼ぶしかない
- ランナーは Windows サービス（NETWORK SERVICE）として動く。手元の対話シェルとは実行アカウントが違うので、シェル依存の挙動は再現しない
- エックスサーバーの SSH は「国内からのアクセスのみ許可」が前提。GitHub ホストランナー（国外 IP）からは繋がらない

## 文章のトーン

日本語。コミットメッセージは「何をしたか」より**なぜそうしたか・何を踏んだか**を本文に厚く書く。エラーの実文言・切り分けの手がかりまで残す。README の「踏んだ落とし穴」の表も同じ方針で、症状・原因・対応の3列を守る。
