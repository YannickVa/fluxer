// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated synthetic browser acceptance fixture; never connects to a deployed API.

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../../..');
const app = path.join(repository, 'fluxer_app');
const require = createRequire(path.join(app, 'package.json'));
const {rspack, HtmlRspackPlugin} = require('@rspack/core');
const {chromium} = createRequire(path.join(repository, 'package.json'))('playwright');
const {getLinguiSwcPluginConfig} = await import(pathToFileURL(path.join(app, 'scripts/build/rspack/lingui.mjs')).href);
const linguiPlugin = getLinguiSwcPluginConfig();
linguiPlugin[0] = require.resolve('@lingui/swc-plugin');
const aliases = Object.fromEntries(
	[
		'app/Routes',
		'features/app/state/RuntimeConfig',
		'features/auth/flow/AuthRuntimeTargetGate',
		'features/devtools/state/DeveloperOptions',
		'features/auth/state/Authentication',
		'features/platform/state/AuthSession',
		'features/window/hooks/useFluxerDocumentTitle',
		'features/platform/components/router/RouterReact',
		'features/ui/utils/MobileExperience',
		'features/user/utils/LocaleUtils',
		'features/app/components/shared/ExternalLink',
		'features/platform/utils/AutofocusUtils',
		'features/ui/state/KeyboardMode',
		'features/accessibility/state/Accessibility',
	].map((name) => [`@app/${name}$`, path.join(directory, 'environment.tsx')]),
);
const artifacts = path.join(repository, 'artifacts/migration-claim-browser');
const compiler = rspack({
	mode: 'development',
	context: app,
	entry: path.join(directory, 'entry.tsx'),
	experiments: {css: true},
	output: {path: path.join(artifacts, 'dist'), filename: 'claim.js', publicPath: '/'},
	devtool: false,
	resolve: {
		extensions: ['.tsx', '.ts', '.js', '.mjs'],
		alias: {...aliases, '@app': path.join(app, 'src'), '@fluxer': path.join(repository, 'packages')},
		modules: [path.join(app, 'node_modules'), path.join(repository, 'node_modules'), 'node_modules'],
	},
	module: {
		rules: [
			{
				test: /\.[jt]sx?$/,
				exclude: /node_modules/,
				use: {
					loader: 'builtin:swc-loader',
					options: {
						jsc: {
							parser: {syntax: 'typescript', tsx: true, decorators: true},
							transform: {legacyDecorator: true, react: {runtime: 'automatic'}},
							experimental: {plugins: [linguiPlugin]},
							target: 'es2022',
						},
					},
				},
			},
			{test: /\.module\.css$/, type: 'css/module', parser: {namedExports: false}, use: ['postcss-loader']},
			{test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: ['postcss-loader']},
			{test: /\.svg$/, resourceQuery: /react/, use: ['@svgr/webpack']},
			{test: /\.(svg|woff2?|png|webp)$/, resourceQuery: {not: [/react/]}, type: 'asset/resource'},
		],
	},
	plugins: [
		new HtmlRspackPlugin({
			templateContent:
				'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
		}),
	],
});
await new Promise((resolve, reject) =>
	compiler.run((error, stats) => {
		if (error) {
			reject(error);
			return;
		}
		if (stats.hasErrors()) {
			const errors = stats.toJson({all: false, errors: true}).errors;
			reject(
				new Error(
					JSON.stringify(
						errors.slice(0, 8).map((entry) => ({module: entry.moduleName, message: entry.message.slice(0, 220)})),
					),
				),
			);
			return;
		}
		resolve();
	}),
);
await new Promise((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())));
console.log('Isolated real-component claim UI compiled.');

const server = createServer(async (request, response) => {
	try {
		const pathname = new URL(request.url, 'http://localhost').pathname;
		const filename = pathname === '/migration/claim' ? 'index.html' : pathname.slice(1);
		const resolved = path.resolve(artifacts, 'dist', filename);
		if (!resolved.startsWith(path.join(artifacts, 'dist') + path.sep)) {
			response.writeHead(404);
			response.end();
			return;
		}
		const data = await readFile(resolved);
		response.setHeader(
			'Content-Type',
			filename.endsWith('.js')
				? 'text/javascript'
				: filename.endsWith('.css')
					? 'text/css'
					: filename.endsWith('.woff2')
						? 'font/woff2'
						: 'text/html',
		);
		response.end(data);
	} catch {
		response.writeHead(404);
		response.end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
	browser = await chromium.launch({channel: process.env.FLUXER_CLAIM_BROWSER_CHANNEL || undefined, headless: true});
	for (const [name, width, height] of [
		['desktop', 1280, 900],
		['mobile', 390, 844],
	]) {
		const context = await browser.newContext({viewport: {width, height}});
		const page = await context.newPage();
		await page.addInitScript(() => {
			window.__claimFixturePointerInputs = 0;
			document.addEventListener(
				'pointerdown',
				() => {
					window.__claimFixturePointerInputs++;
				},
				true,
			);
		});
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		let requests = 0;
		let completed;
		await page.route(`${base}/api/**`, async (route) => {
			requests++;
			const url = route.request().url();
			if (url.endsWith('/complete')) completed = route.request().postDataJSON();
			const json = url.endsWith('/redeem')
				? {
						proof: `mp1.${'A'.repeat(43)}`,
						expires_at: new Date(Date.now() + 900_000).toISOString(),
						username: 'synthetic-migrant',
						date_of_birth_required: true,
					}
				: url.endsWith('/email')
					? {
							challenge: `me1.${'A'.repeat(43)}`,
							expires_at: new Date(Date.now() + 300_000).toISOString(),
							resend_available_at: new Date(Date.now() + 30_000).toISOString(),
						}
					: {user_id: '1400000000000000102', login_required: true};
			await route.fulfill({json});
		});
		await page.goto(`${base}/migration/claim#token=mc1.${'A'.repeat(43)}`);
		try {
			await page.getByRole('button', {name: 'Confirm ownership', exact: true}).waitFor({timeout: 5000});
		} catch {
			throw new Error(JSON.stringify({errors, text: (await page.locator('body').innerText()).slice(0, 500)}));
		}
		assert.equal(new URL(page.url()).hash, '');
		assert.equal(requests, 0);
		await page.screenshot({path: path.join(artifacts, `${name}-confirm.png`), fullPage: true});
		await page.keyboard.press('Tab');
		assert.equal(await page.locator(':focus').textContent(), 'Confirm ownership');
		await page.keyboard.press('Enter');
		await page.getByLabel('Email', {exact: true}).fill('synthetic@example.invalid');
		await page.getByRole('button', {name: 'Send verification code', exact: true}).press('Enter');
		await page.getByLabel('Email verification code', {exact: true}).waitFor();
		await page.evaluate(() => document.fonts.ready);
		const consentLayout = await page
			.locator('[data-flx="auth.flow.registration-legal-consent.consent-row"]')
			.evaluate((element) => ({
				width: element.clientWidth,
				scroll: element.scrollWidth,
				children: [...element.querySelectorAll('*')].slice(0, 8).map((child) => ({
					tag: child.tagName,
					role: child.getAttribute('role'),
					width: child.getBoundingClientRect().width,
					minWidth: getComputedStyle(child).minWidth,
					flex: getComputedStyle(child).flex,
					whiteSpace: getComputedStyle(child).whiteSpace,
				})),
			}));
		assert.ok(consentLayout.scroll <= consentLayout.width, JSON.stringify(consentLayout));
		await page.screenshot({path: path.join(artifacts, `${name}-complete.png`), fullPage: true});
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		await page.getByLabel('Email verification code', {exact: true}).fill('synthetic-code');
		await page.getByLabel('New password', {exact: true}).fill('Synthetic password! 492');
		await page.getByLabel('Confirm new password', {exact: true}).fill('Synthetic password! 492');
		if (name === 'mobile') {
			await page.locator('input[type="date"]').fill('1998-03-11');
		} else {
			for (const [placeholder, text] of [
				['Month', 'March'],
				['Day', '11'],
				['Year', '1998'],
			]) {
				await page.getByPlaceholder(placeholder, {exact: true}).fill(text);
				await page.getByRole('option', {name: text, exact: true}).press('Enter');
			}
		}
		await page.locator('button[role="checkbox"]').press('Space');
		await page.getByRole('button', {name: 'Finish claiming', exact: true}).press('Enter');
		await page.getByRole('heading', {name: 'Your account is ready', exact: true}).waitFor();
		assert.equal(completed.date_of_birth, '1998-03-11');
		assert.equal(completed.consent, true);
		assert.equal(await page.getByRole('link', {name: 'Go to sign-in'}).getAttribute('href'), '/login');
		await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
		await page.getByRole('alert').waitFor();
		assert.equal(await page.locator('input').count(), 0);
		assert.deepEqual(errors, []);
		assert.equal(await page.evaluate(() => window.__claimFixturePointerInputs), 0);
		await context.close();
		console.log(
			`${name}: explicit ownership, scrubbed URL, keyboard confirmation, real email/password/DOB/consent controls, completed claim, no overflow, pagehide cleanup passed.`,
		);
	}
	const context = await browser.newContext();
	await context.addInitScript(() => {
		window.__fixtureSignedIn = true;
	});
	const page = await context.newPage();
	let requests = 0;
	await page.route(`${base}/api/**`, async (route) => {
		requests++;
		await route.abort();
	});
	await page.goto(`${base}/migration/claim#token=mc1.${'A'.repeat(43)}`);
	await page.getByText('You are already signed in.', {exact: false}).waitFor();
	assert.equal(requests, 0);
	assert.equal(await page.locator('button').count(), 0);
	await page.screenshot({path: path.join(artifacts, 'existing-session.png'), fullPage: true});
	await context.close();
	console.log(
		'Existing-session browser guard passed without a claim request. Synthetic API/session fixture, not a native deployed rehearsal.',
	);
	const unsafeContext = await browser.newContext();
	await unsafeContext.addInitScript(() => {
		history.replaceState = () => {
			throw new Error('Synthetic history failure');
		};
	});
	const unsafePage = await unsafeContext.newPage();
	const unsafeErrors = [];
	unsafePage.on('pageerror', (error) => unsafeErrors.push(error.message));
	let unsafeRequests = 0;
	await unsafePage.route(`${base}/api/**`, async (route) => {
		unsafeRequests++;
		await route.abort();
	});
	await unsafePage.goto(`${base}/migration/claim#token=mc1.${'A'.repeat(43)}`);
	await unsafePage.getByRole('alert').waitFor();
	assert.equal(unsafeRequests, 0);
	assert.equal(await unsafePage.locator('input, button').count(), 0);
	assert.deepEqual(unsafeErrors, ['Migration claim URL cleanup failed.']);
	assert.ok(!(await unsafePage.locator('body').innerText()).includes('mc1.'));
	await unsafeContext.close();
	console.log('Unsafe URL cleanup aborts normal app startup without exposing the credential or native error.');
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}
