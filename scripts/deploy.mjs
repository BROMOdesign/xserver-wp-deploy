/**
 * WordPress テーマをエックスサーバーへ SFTP 転送する
 *
 * 使い方:
 *   node scripts/deploy.mjs [--dry-run] [--init] [--list]
 *
 *   --dry-run  転送・削除を行わず、実行予定の一覧だけを出す
 *   --init     転送先ガード（Theme Name 照合）を飛ばす。空ディレクトリへの初回投入用
 *   --list     サーバーに接続せず、転送対象のファイル一覧だけを出して終了する
 *
 * 設定はリポジトリ直下の deploy.config.json を読む。
 *
 * 必要な環境変数（CI では GitHub Secrets、ローカルでは .env）:
 *   XSERVER_HOST / XSERVER_USER / XSERVER_PORT / XSERVER_DEPLOY_PATH
 *   XSERVER_SSH_KEY（未設定なら ssh-agent を使う）
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SftpClient from 'ssh2-sftp-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'deploy.config.json');

const flags = new Set(process.argv.slice(2));
const DRY_RUN = flags.has('--dry-run');
const INIT = flags.has('--init');
const LIST_ONLY = flags.has('--list');

function log(msg) {
	console.log(msg);
}

function fail(msg) {
	console.error(`\n✗ ${msg}`);
	process.exit(1);
}

async function loadConfig() {
	if (!existsSync(CONFIG_PATH)) {
		fail('deploy.config.json がありません。deploy.config.example.json をコピーして作成してください。');
	}

	const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

	for (const key of ['themeMarker', 'manifest', 'include']) {
		if (!config[key]) {
			fail(`deploy.config.json に ${key} がありません。`);
		}
	}

	return config;
}

// ------------------------------------------------------------------
// 認証
// ------------------------------------------------------------------

// Windows の OpenSSH エージェントは名前付きパイプで待ち受ける
const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/**
 * XSERVER_SSH_KEY があればそれを使い（CI はこちら）、無ければ ssh-agent に
 * 委ねる（ローカルはこちら）。エージェント経由ならパスフレーズ付きの鍵を
 * そのまま使えるので、パスフレーズを外した鍵をディスクに置かずに済む。
 */
function resolveAuth() {
	const raw = process.env.XSERVER_SSH_KEY;

	if (raw) {
		// Secrets への貼り付け方によっては改行が "\n" というリテラルになる
		const key = !raw.includes('\n') && raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
		return { privateKey: key, describe: '秘密鍵（XSERVER_SSH_KEY）' };
	}

	const agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? WINDOWS_AGENT_PIPE : null);

	if (agent) {
		return { agent, describe: `ssh-agent（${agent}）` };
	}

	fail('XSERVER_SSH_KEY が未設定で、ssh-agent も見つかりません。どちらかを用意してください。');
}

function readEnv() {
	const required = ['XSERVER_HOST', 'XSERVER_USER', 'XSERVER_DEPLOY_PATH'];
	const missing = required.filter((key) => !process.env[key]);

	if (missing.length > 0) {
		fail(`環境変数が足りません: ${missing.join(', ')}`);
	}

	return {
		host: process.env.XSERVER_HOST,
		username: process.env.XSERVER_USER,
		port: Number(process.env.XSERVER_PORT || 10022),
		auth: resolveAuth(),
		// 末尾のスラッシュを落として以降のパス結合を揃える
		remoteRoot: process.env.XSERVER_DEPLOY_PATH.replace(/\/+$/, ''),
	};
}

// ------------------------------------------------------------------
// ローカル側の収集
//
// 除外リストではなく許可リストにしている。除外し忘れると src/ や
// node_modules/ が本番に出てしまうが、許可し忘れは「表示が壊れる」で
// 済むため、事故ったときの被害が軽い方に倒す。
// ------------------------------------------------------------------

function matchesGlob(name, globs) {
	return globs.some((g) => {
		const re = new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
		return re.test(name);
	});
}

async function walk(dir, out) {
	for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`;

		if (entry.isDirectory()) {
			await walk(rel, out);
			continue;
		}

		if (entry.isFile()) {
			const info = await stat(path.join(ROOT, rel));
			out.set(rel, { size: info.size });
		}
	}
}

async function collectLocal(config) {
	const files = new Map();
	const { rootGlobs = [], rootFiles = [], dirs = [] } = config.include;

	for (const entry of await readdir(ROOT, { withFileTypes: true })) {
		if (!entry.isFile()) {
			continue;
		}
		if (matchesGlob(entry.name, rootGlobs) || rootFiles.includes(entry.name)) {
			const info = await stat(path.join(ROOT, entry.name));
			files.set(entry.name, { size: info.size });
		}
	}

	for (const dir of dirs) {
		if (existsSync(path.join(ROOT, dir))) {
			await walk(dir, files);
		}
	}

	return files;
}

/**
 * ビルド漏れ・壊れたビルドを転送前に弾く
 *
 * manifest が欠けたり中身と assets が食い違ったりすると、テーマ側の
 * アセット URL が空になり、PHP エラー無しに無スタイルページになる。
 * 本番で気付きにくいので、ここで確実に落とす。
 */
async function preflight(config, files) {
	if (!files.has(config.manifest)) {
		fail(`${config.manifest} がありません。先に npm run build を実行してください。`);
	}

	const manifest = JSON.parse(await readFile(path.join(ROOT, config.manifest), 'utf8'));
	const entries = Object.values(manifest);

	if (entries.length === 0) {
		fail('manifest が空です。ビルドをやり直してください。');
	}

	// manifest のパスは dist ルートからの相対。manifest 自身の位置から dist ルートを求める
	const distRoot = config.manifest.split('/')[0];

	for (const entry of entries) {
		if (!files.has(`${distRoot}/${entry.file}`)) {
			fail(`manifest が参照する ${distRoot}/${entry.file} が存在しません。ビルドをやり直してください。`);
		}
	}

	return entries.map((entry) => entry.file);
}

// ------------------------------------------------------------------
// リモート側
// ------------------------------------------------------------------

async function collectRemote(sftp, remoteRoot, dir = '') {
	const files = new Map();
	const target = dir ? `${remoteRoot}/${dir}` : remoteRoot;

	let entries;
	try {
		entries = await sftp.list(target);
	} catch {
		// 未作成のディレクトリは空として扱う
		return files;
	}

	for (const entry of entries) {
		const rel = dir ? `${dir}/${entry.name}` : entry.name;

		if (entry.type === 'd') {
			for (const [key, value] of await collectRemote(sftp, remoteRoot, rel)) {
				files.set(key, value);
			}
		} else if (entry.type === '-') {
			files.set(rel, { size: entry.size });
		}
	}

	return files;
}

/**
 * 転送先が本当にこのテーマのディレクトリかを確かめる
 *
 * DEPLOY_PATH の設定ミスで無関係なディレクトリの中身を削除するのが
 * このスクリプトで最も危険な事故なので、削除の前に必ず通す。
 */
async function guardRemote(sftp, remoteRoot, marker) {
	if (INIT) {
		log('⚠ --init が指定されているため転送先ガードを飛ばします');
		return;
	}

	let content;
	try {
		content = (await sftp.get(`${remoteRoot}/style.css`)).toString('utf8');
	} catch {
		fail(
			`転送先に style.css がありません: ${remoteRoot}\n` +
				'  パスが正しいか確認してください。空のディレクトリへの初回投入なら --init を付けてください。'
		);
	}

	if (!content.includes(marker)) {
		fail(
			`転送先の style.css が想定のテーマではありません: ${remoteRoot}\n` +
				`  "${marker}" が見つかりませんでした。XSERVER_DEPLOY_PATH を確認してください。`
		);
	}
}

// ------------------------------------------------------------------
// 転送計画
// ------------------------------------------------------------------

/**
 * 毎回すべてのファイルをアップロードする
 *
 * 差分だけ送る手もあるが、信頼できる判定材料が無い。ssh2-sftp-client には
 * mtime を設定する API が無いため、リモートの mtime は常に「アップロード
 * した時刻」になり、ローカルとの比較が成立しない。サイズだけの比較に
 * 落とすと、バイト数が変わらない書き換え（1文字の修正など）を取りこぼし、
 * しかもそれが無言で起きる。テーマ規模なら数十秒なので確実さを取る。
 */
function planUploads(local, manifestPath) {
	const distRoot = manifestPath.split('/')[0];

	// アップロード順序が切り替えの原子性を担保する。
	//   1. dist 以外（PHP・画像）
	//   2. dist の新しいハッシュ資産
	//   3. manifest ← ここで初めて新アセットを指す
	// 旧アセットの削除は後段なので「manifest が指すファイルが無い」瞬間が生まれない。
	const rank = (rel) => (rel === manifestPath ? 2 : rel.startsWith(`${distRoot}/`) ? 1 : 0);

	return [...local.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function planDeletions(local, remote, protectedNames) {
	const guard = new Set(protectedNames || []);

	return [...remote.keys()].filter((rel) => !local.has(rel) && !guard.has(path.posix.basename(rel))).sort();
}

async function upload(sftp, remoteRoot, rel) {
	const remotePath = `${remoteRoot}/${rel}`;
	const dir = path.posix.dirname(remotePath);

	if (!(await sftp.exists(dir))) {
		await sftp.mkdir(dir, true);
	}

	await sftp.put(path.join(ROOT, rel), remotePath);
}

// ------------------------------------------------------------------

async function main() {
	const started = Date.now();
	const config = await loadConfig();
	const local = await collectLocal(config);
	const assets = await preflight(config, local);

	// --list は接続情報を必要としない。転送対象の確認をサーバーや鍵の
	// 用意より先にできるようにしておく。
	if (LIST_ONLY) {
		for (const rel of [...local.keys()].sort()) {
			log(rel);
		}
		log(`\n${local.size} ファイル`);
		return;
	}

	const env = readEnv();

	log(`デプロイ先: ${env.username}@${env.host}:${env.port}`);
	log(`パス:       ${env.remoteRoot}`);
	log(`認証:       ${env.auth.describe}`);
	if (DRY_RUN) {
		log('モード:     ドライラン（書き込みは行いません）');
	}
	log('');
	log(`ローカルの転送対象: ${local.size} ファイル`);
	log(`適用するアセット:   ${assets.join(', ')}`);
	log('');

	const sftp = new SftpClient();

	try {
		await sftp.connect({
			host: env.host,
			port: env.port,
			username: env.username,
			...(env.auth.privateKey ? { privateKey: env.auth.privateKey } : { agent: env.auth.agent }),
			readyTimeout: 30000,
		});

		await guardRemote(sftp, env.remoteRoot, config.themeMarker);

		const remote = await collectRemote(sftp, env.remoteRoot);
		const uploads = planUploads(local, config.manifest);
		const deletions = planDeletions(local, remote, config.protected);

		log(`リモートの既存ファイル: ${remote.size}`);
		log('');
		log(`アップロード: ${uploads.length} ファイル`);
		for (const rel of uploads) {
			log(`  + ${rel}`);
		}
		log('');
		log(deletions.length === 0 ? '削除: なし' : `削除: ${deletions.length} ファイル`);
		for (const rel of deletions) {
			log(`  - ${rel}`);
		}
		log('');

		if (DRY_RUN) {
			log('ドライランのため何も変更していません。');
			return;
		}

		for (const rel of uploads) {
			await upload(sftp, env.remoteRoot, rel);
		}

		for (const rel of deletions) {
			await sftp.delete(`${env.remoteRoot}/${rel}`);
		}

		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		const mb = ([...local.values()].reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(1);
		log(`✓ 完了（アップロード ${uploads.length} ファイル ${mb}MB / 削除 ${deletions.length} / ${seconds}s）`);
	} finally {
		await sftp.end().catch(() => {});
	}
}

main().catch((error) => {
	fail(error && error.message ? error.message : String(error));
});
