/**
 * デプロイ後の検証
 *
 * 使い方:
 *   node scripts/healthcheck.mjs [baseUrl]
 *
 * 「200 が返るか」だけでは不十分。Vite の manifest が読めないとテーマは
 * アセット URL に空文字を返し、enqueue 側がそれを握り潰すため、CSS/JS が
 * 一切読まれない無スタイルページでも 200 が返る。
 *
 * そこでローカルの manifest が指すハッシュ付きファイル名が、実際に配信
 * された HTML に現れているかまで確かめる。一致すれば「manifest と assets
 * が同一ビルドで揃った状態で公開されている」ことの証明になる。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'deploy.config.json');

if (!existsSync(CONFIG_PATH)) {
	console.error('✗ deploy.config.json がありません。');
	process.exit(1);
}

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const hc = config.healthcheck || {};

const BASE_URL = (process.argv[2] || process.env.DEPLOY_URL || hc.baseUrl || '').replace(/\/+$/, '');

if (!BASE_URL) {
	console.error('✗ baseUrl が決まりません。deploy.config.json か引数で指定してください。');
	process.exit(1);
}

const failures = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const ng = (m) => {
	console.log(`  ✗ ${m}`);
	failures.push(m);
};

async function fetchPage(url) {
	const response = await fetch(url, {
		redirect: 'follow',
		headers: { 'User-Agent': 'deploy-healthcheck' },
	});
	return { status: response.status, body: await response.text() };
}

/**
 * manifest のハッシュが実際に配信されているか
 *
 * ここが健全性チェックの本体。1つでも欠けたら無スタイルページ。
 */
async function checkAssets() {
	console.log('\n[1] 配信されたアセットが最新ビルドと一致するか');

	const manifest = JSON.parse(await readFile(path.join(ROOT, config.manifest), 'utf8'));
	const expected = Object.values(manifest).map((entry) => entry.file);
	const distRoot = config.manifest.split('/')[0];

	// manifest の全エントリが assetPagePath の HTML に出るとは限らない。
	// ページ別にしか enqueue されない JS や、HTML ではなく CSS から参照される
	// 背景画像は、正常でも現れない。htmlAssets が指定されていればその
	// manifest キーだけを必須とし、未指定なら従来どおり全件を必須とする。
	const htmlAssets = Array.isArray(hc.htmlAssets) ? hc.htmlAssets : null;

	if (htmlAssets) {
		const unknown = htmlAssets.filter((key) => !manifest[key]);

		if (unknown.length > 0) {
			ng(`htmlAssets に manifest に無いキーがあります: ${unknown.join(', ')}`);
		}
	}

	const required = htmlAssets
		? htmlAssets.filter((key) => manifest[key]).map((key) => manifest[key].file)
		: expected;

	const { status, body } = await fetchPage(BASE_URL + (hc.assetPagePath || '/'));

	if (status !== 200) {
		ng(`${hc.assetPagePath || '/'} が ${status} を返しました（200 を期待）`);
		return;
	}

	if (required.length === 0) {
		ng('HTML への出現を確認する対象が0件です。htmlAssets の指定を見直してください。');
	}

	for (const file of required) {
		if (body.includes(file)) {
			ok(`HTML が ${file} を参照している`);
		} else {
			ng(`HTML に ${file} が現れません（manifest が切り替わっていない可能性）`);
		}
	}

	for (const file of expected.filter((f) => !required.includes(f))) {
		ok(`${file} は HTML 出現の必須対象外（htmlAssets 指定）`);
	}

	// 参照されているだけでなく、実体が取得できるかまで見る
	for (const file of expected) {
		const url = `${BASE_URL}${hc.themeUrlPath}/${distRoot}/${file}`;
		const response = await fetch(url, { headers: { 'User-Agent': 'deploy-healthcheck' } });
		const length = (await response.text()).length;

		if (response.status === 200 && length > 0) {
			ok(`${file} が取得できる（${length} bytes）`);
		} else {
			ng(`${file} の取得に失敗（status ${response.status} / ${length} bytes）`);
		}
	}
}

async function checkPages() {
	console.log('\n[2] 主要ページの応答');

	const expectations = [...(hc.pages || [])];

	if (hc.notFoundPath) {
		expectations.push({ path: hc.notFoundPath, expect: 404 });
	}

	for (const { path: urlPath, expect } of expectations) {
		const { status } = await fetchPage(BASE_URL + urlPath);

		if (status === expect) {
			ok(`${urlPath} → ${status}`);
		} else {
			ng(`${urlPath} → ${status}（${expect} を期待）`);
		}
	}
}

/**
 * 404 がテーマの 404.php で描画されているか
 *
 * ステータスだけでは WordPress 既定の出力かテーマのものか区別できないため、
 * 404.php にしか無い文言で判定する。
 */
async function checkNotFoundTemplate() {
	if (!hc.notFoundPath || !hc.notFoundNeedle) {
		return;
	}

	console.log('\n[3] 404 ページがテーマのテンプレートか');

	const { body } = await fetchPage(BASE_URL + hc.notFoundPath);

	if (body.includes(hc.notFoundNeedle)) {
		ok(`404.php の目印「${hc.notFoundNeedle}」が出力されている`);
	} else {
		ng(`404.php の目印「${hc.notFoundNeedle}」が見つかりません`);
	}
}

console.log(`ヘルスチェック: ${BASE_URL}`);

await checkAssets();
await checkPages();
await checkNotFoundTemplate();

console.log('');

if (failures.length > 0) {
	console.error(`✗ ${failures.length} 件の問題があります`);
	process.exit(1);
}

console.log('✓ すべて問題ありません');
