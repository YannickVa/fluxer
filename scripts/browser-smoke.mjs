// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {chromium} from 'playwright';

const DEFAULT_LOCAL_URL = 'http://localhost:8088';
const PRODUCTION_HOSTNAME = 'matskos.duckdns.org';
const STAGING_HEALTH_PATHS = ['/_health', '/api/_health', '/gateway/_health', '/media/_health', '/admin/_health'];
const LOCAL_HEALTH_PATHS = ['/api/_health', '/gateway/_health', '/media/_health'];
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SETTLE_MS = 1_000;

function readBoolean(name, fallback = false) {
	const value = process.env[name];
	if (value === undefined) return fallback;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error(`${name} must be either "true" or "false".`);
}

function readPositiveInteger(name, fallback) {
	const value = process.env[name];
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return parsed;
}

function readHealthPaths(baseUrl) {
	const configured = process.env.FLUXER_BROWSER_SMOKE_HEALTH_PATHS;
	if (configured !== undefined) {
		return configured
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean);
	}
	return ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname) ? LOCAL_HEALTH_PATHS : STAGING_HEALTH_PATHS;
}

function normalizeBaseUrl(value) {
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol)) {
		throw new Error('FLUXER_BROWSER_SMOKE_BASE_URL must use http or https.');
	}
	url.pathname = '/';
	url.search = '';
	url.hash = '';
	return url;
}

function artifactFileName(startedAt, suffix) {
	return `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${suffix}`;
}

function redactUrl(value) {
	try {
		const url = new URL(value);
		url.search = '';
		url.hash = '';
		return url.href;
	} catch {
		return '<non-http request>';
	}
}

const startedAt = new Date().toISOString();
const baseUrl = normalizeBaseUrl(process.env.FLUXER_BROWSER_SMOKE_BASE_URL ?? DEFAULT_LOCAL_URL);
const timeoutMs = readPositiveInteger('FLUXER_BROWSER_SMOKE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
const settleMs = readPositiveInteger('FLUXER_BROWSER_SMOKE_SETTLE_MS', DEFAULT_SETTLE_MS);
const expectedVersion = process.env.FLUXER_BROWSER_SMOKE_EXPECTED_VERSION?.trim() || null;
const email = process.env.FLUXER_BROWSER_SMOKE_EMAIL?.trim() || null;
const password = process.env.FLUXER_BROWSER_SMOKE_PASSWORD || null;
const browserChannel =
	process.env.FLUXER_BROWSER_SMOKE_BROWSER_CHANNEL?.trim() || (process.platform === 'win32' ? 'msedge' : null);
const ignoreHTTPSErrors = readBoolean('FLUXER_BROWSER_SMOKE_IGNORE_HTTPS_ERRORS');
const allowProduction = readBoolean('FLUXER_BROWSER_SMOKE_ALLOW_PRODUCTION');
const headless = !readBoolean('FLUXER_BROWSER_SMOKE_HEADED');
const healthPaths = readHealthPaths(baseUrl);
const traceEnabled = email === null;
const artifactsDirectory = path.resolve(process.env.FLUXER_BROWSER_SMOKE_ARTIFACTS_DIR ?? 'artifacts/browser-smoke');

if ((email === null) !== (password === null)) {
	throw new Error('Set both FLUXER_BROWSER_SMOKE_EMAIL and FLUXER_BROWSER_SMOKE_PASSWORD, or neither.');
}
if (baseUrl.hostname === PRODUCTION_HOSTNAME && !allowProduction) {
	throw new Error('Production browser smoke is disabled. Set FLUXER_BROWSER_SMOKE_ALLOW_PRODUCTION=true deliberately.');
}

await mkdir(artifactsDirectory, {recursive: true});

const report = {
	startedAt,
	completedAt: null,
	baseUrl: baseUrl.origin,
	browserChannel,
	browserVersion: null,
	headless,
	ignoreHTTPSErrors,
	authenticated: email !== null,
	traceEnabled,
	expectedVersion,
	actualVersion: null,
	checks: [],
	diagnostics: {
		consoleErrors: [],
		pageErrors: [],
		requestFailures: [],
	},
	status: 'running',
	error: null,
};

function pass(name, details = {}) {
	report.checks.push({name, status: 'passed', ...details});
	console.log(`PASS ${name}`);
}

async function writeReport() {
	report.completedAt = new Date().toISOString();
	const reportPath = path.join(artifactsDirectory, artifactFileName(startedAt, 'report.json'));
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	console.log(`Report: ${reportPath}`);
}

let browser;
let context;
let page;

try {
	browser = await chromium.launch({
		...(browserChannel ? {channel: browserChannel} : {}),
		headless,
	});
	report.browserVersion = browser.version();
	context = await browser.newContext({
		baseURL: baseUrl.origin,
		ignoreHTTPSErrors,
	});
	context.setDefaultTimeout(timeoutMs);
	context.setDefaultNavigationTimeout(timeoutMs);
	if (traceEnabled) await context.tracing.start({screenshots: true, snapshots: true, sources: true});
	page = await context.newPage();

	for (const healthPath of healthPaths) {
		const response = await page.goto(new URL(healthPath, baseUrl).href, {waitUntil: 'commit', timeout: timeoutMs});
		assert(response, `${healthPath} did not return a response.`);
		assert.equal(response.status(), 200, `${healthPath} returned HTTP ${response.status()}`);
		pass(`health ${healthPath}`, {statusCode: response.status()});
	}

	if (expectedVersion !== null) {
		const response = await page.goto(new URL('/version.json', baseUrl).href, {waitUntil: 'commit', timeout: timeoutMs});
		assert(response, '/version.json did not return a response.');
		assert.equal(response.status(), 200, `/version.json returned HTTP ${response.status()}`);
		const payload = JSON.parse(await response.text());
		report.actualVersion = typeof payload.version === 'string' ? payload.version : null;
		assert.equal(report.actualVersion, expectedVersion, 'The deployed web version did not match the expected version.');
		pass('web version', {actualVersion: report.actualVersion});
	}

	page.on('console', (message) => {
		if (message.type() === 'error') report.diagnostics.consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => report.diagnostics.pageErrors.push(error.message));
	page.on('requestfailed', (request) => {
		report.diagnostics.requestFailures.push({
			url: redactUrl(request.url()),
			error: request.failure()?.errorText ?? 'unknown',
		});
	});

	const response = await page.goto('/login', {waitUntil: 'domcontentloaded'});
	assert(response, 'The login navigation did not return a response.');
	assert.equal(response.status(), 200, `/login returned HTTP ${response.status()}`);
	await page.locator('form[name="login"]').waitFor({state: 'visible'});
	await page.locator('input[name="email"]').waitFor({state: 'visible'});
	await page.locator('input[name="password"]').waitFor({state: 'visible'});
	pass('login page renders');

	if (email !== null && password !== null) {
		await page.locator('input[name="email"]').fill(email);
		await page.locator('input[name="password"]').fill(password);
		await page.locator('form[name="login"] button[type="submit"]').click();
		await page.waitForURL((url) => !url.pathname.startsWith('/login'), {timeout: timeoutMs});
		await page
			.locator('[data-flx="channel.direct-message.dm-friends-view.container"]')
			.waitFor({state: 'visible', timeout: timeoutMs});
		assert.match(page.url(), /\/channels\/@me(?:\/|$)/, 'Login did not reach the friends area.');
		pass('authenticated friends view renders', {pathname: new URL(page.url()).pathname});
	}

	await page.waitForTimeout(settleMs);
	assert.deepEqual(report.diagnostics.pageErrors, [], 'The page emitted runtime errors.');
	pass('no page runtime errors');

	report.status = 'passed';
	if (traceEnabled) await context.tracing.stop();
} catch (error) {
	report.status = 'failed';
	report.error = error instanceof Error ? error.message : String(error);
	if (page) {
		await page
			.locator('input[name="email"]')
			.fill('')
			.catch(() => undefined);
		await page
			.locator('input[name="password"]')
			.fill('')
			.catch(() => undefined);
		await page
			.screenshot({path: path.join(artifactsDirectory, artifactFileName(startedAt, 'failure.png')), fullPage: true})
			.catch(() => undefined);
	}
	if (context && traceEnabled) {
		await context.tracing
			.stop({path: path.join(artifactsDirectory, artifactFileName(startedAt, 'trace.zip'))})
			.catch(() => undefined);
	}
	console.error(`FAIL ${report.error}`);
	process.exitCode = 1;
} finally {
	await browser?.close().catch(() => undefined);
	await writeReport();
}
