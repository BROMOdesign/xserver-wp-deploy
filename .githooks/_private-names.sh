#!/bin/sh
# public リポジトリに書いてはいけない語（案件名・クライアント名など）を弾くための共通部分。
#
# 語のリスト自体はこのリポジトリには置かない。置いたら公開してしまい本末転倒なので、
# リポジトリ外の ~/.config/git/private-names.txt に 1 行 1 パターン（拡張正規表現）で書く。
# # で始まる行と空行は無視する。ファイルが無ければフックは素通りする。
#
# 一時的に迂回したいときは git commit --no-verify。

private_names_regex() {
	list="${PRIVATE_NAMES_FILE:-$HOME/.config/git/private-names.txt}"
	[ -f "$list" ] || return 1
	grep -v -E '^[[:space:]]*(#|$)' "$list" | tr '\n' '|' | sed 's/|$//'
}
