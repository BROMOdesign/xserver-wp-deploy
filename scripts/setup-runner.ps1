<#
.SYNOPSIS
	案件リポジトリ用のセルフホストランナーを1コマンドで用意する。

.DESCRIPTION
	ランナーの登録スコープは repository / organization / enterprise の3つで、
	個人（User）アカウントには organization スコープが無い。つまり案件ごとに
	1インストールが必須になる。手順そのものは減らせないので、代わりに
	丸ごとスクリプトにした。

	README の手順5で踏んだ事故を構造的に防ぐ:
	  - ディレクトリ名にリポジトリ名を必ず入れる（固定名だと2案件目で衝突する）
	  - 既存のランナーの配下に入れ子で展開しない
	  - 管理者権限が無いまま config.cmd を走らせない
	    （登録だけ済んで already configured で詰む）

	要 gh CLI（認証済み）、要管理者 PowerShell。

.EXAMPLE
	.\scripts\setup-runner.ps1 -Repo BROMOdesign/my-theme

.EXAMPLE
	# 既に別案件で落とした zip を使い回してダウンロードを省く
	.\scripts\setup-runner.ps1 -Repo BROMOdesign/my-theme -ZipPath C:\actions-runner-other\actions-runner-win-x64-2.328.0.zip
#>
[CmdletBinding()]
param(
	# owner/name 形式
	[Parameter(Mandatory)]
	[ValidatePattern('^[^/]+/[^/]+$')]
	[string]$Repo,

	# ランナーを置く親ディレクトリ。リポジトリの外に置くこと
	[string]$Root = 'C:\',

	# 省略時は actions/runner の最新リリースを取る
	[string]$RunnerVersion,

	# ダウンロード済みの zip を使う場合に指定する
	[string]$ZipPath
)

$ErrorActionPreference = 'Stop'

function Fail($message) {
	Write-Host ''
	Write-Host "✗ $message" -ForegroundColor Red
	exit 1
}

function Step($message) {
	Write-Host ''
	Write-Host "▶ $message" -ForegroundColor Cyan
}

# ------------------------------------------------------------------
# 前提の確認
# ------------------------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
	[Security.Principal.WindowsBuiltInRole]::Administrator
)

if (-not $isAdmin) {
	# ここで止めないと、登録だけ済んでサービス化で失敗し、
	# 入れ直そうとしても already configured で弾かれる状態になる
	Fail '管理者権限が必要です。管理者 PowerShell から実行してください。'
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
	Fail 'gh CLI が見つかりません。https://cli.github.com/ から入れてください。'
}

try {
	gh auth status 2>&1 | Out-Null
	if ($LASTEXITCODE -ne 0) { throw }
} catch {
	Fail 'gh が認証されていません。gh auth login を実行してください。'
}

$repoName = $Repo.Split('/')[-1]
$dir = Join-Path $Root "actions-runner-$repoName"

if (Test-Path $dir) {
	if ((Get-ChildItem $dir -Force | Measure-Object).Count -gt 0) {
		Fail "$dir が既にあり、空ではありません。別案件のランナーの中に入れ子で展開しないため中断します。"
	}
} else {
	New-Item -ItemType Directory -Path $dir | Out-Null
}

Write-Host "リポジトリ: $Repo"
Write-Host "設置先:     $dir"

# ------------------------------------------------------------------
# ランナー本体を用意する
# ------------------------------------------------------------------

if (-not $RunnerVersion) {
	Step 'ランナーの最新バージョンを調べる'
	$tag = gh api repos/actions/runner/releases/latest --jq .tag_name
	if ($LASTEXITCODE -ne 0) { Fail 'リリース情報を取得できませんでした。' }
	$RunnerVersion = $tag.TrimStart('v')
}

Write-Host "バージョン: $RunnerVersion"

$zipName = "actions-runner-win-x64-$RunnerVersion.zip"

if (-not $ZipPath) {
	# 同じ親ディレクトリに他案件のランナーがあれば zip を使い回す
	$cached = Get-ChildItem -Path $Root -Filter $zipName -Recurse -Depth 1 -ErrorAction SilentlyContinue |
		Select-Object -First 1

	if ($cached) {
		$ZipPath = $cached.FullName
		Write-Host "既存の zip を使います: $ZipPath"
	}
}

if (-not $ZipPath) {
	Step 'ランナーをダウンロードする'
	$ZipPath = Join-Path $dir $zipName
	$url = "https://github.com/actions/runner/releases/download/v$RunnerVersion/$zipName"
	Invoke-WebRequest -Uri $url -OutFile $ZipPath
}

if (-not (Test-Path $ZipPath)) {
	Fail "zip が見つかりません: $ZipPath"
}

Step '展開する'
Expand-Archive -Path $ZipPath -DestinationPath $dir -Force

if (-not (Test-Path (Join-Path $dir 'config.cmd'))) {
	Fail "展開に失敗しました。config.cmd が見つかりません: $dir"
}

# ------------------------------------------------------------------
# 登録してサービスにする
# ------------------------------------------------------------------

Step '登録トークンを取得する'
$token = gh api -X POST "repos/$Repo/actions/runners/registration-token" --jq .token
if ($LASTEXITCODE -ne 0 -or -not $token) {
	Fail "登録トークンを取得できませんでした。$Repo への admin 権限があるか確認してください。"
}

Step 'ランナーを登録してサービスとして常駐させる'
Push-Location $dir
try {
	# Windows 版に svc.cmd は同梱されていない。サービス登録は
	# config.cmd --runasservice で行う。
	& .\config.cmd --url "https://github.com/$Repo" --token $token --name "$repoName" --work '_work' --runasservice --unattended
	if ($LASTEXITCODE -ne 0) {
		Fail 'config.cmd が失敗しました。既に登録済みなら config.cmd remove --token <remove-token> を先に実行してください。'
	}
} finally {
	Pop-Location
}

Step '状態を確認する'
Get-Service actions.runner.* | Select-Object Name, Status, StartType | Format-Table

Write-Host ''
Write-Host "✓ 完了。$Repo の Settings → Actions → Runners に Idle で出ていれば成功です。" -ForegroundColor Green
