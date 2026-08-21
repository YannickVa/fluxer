// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {chromium} from 'playwright';

const DEFAULT_LOCAL_URL = 'http://localhost:8088';
const PRODUCTION_HOSTNAME = 'matskos.duckdns.org';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 1_000;
const MESSAGE_ROW_SELECTOR = '[role="article"][data-message-id]';
const CHANNEL_TEXTAREA_SELECTOR = '[data-channel-textarea]';
const MESSAGE_HISTORY_READY_SELECTOR = '[data-flx="channel.messages.scroller-spacer"]';
const FRIENDS_VIEW_SELECTOR = '[data-flx="channel.direct-message.dm-friends-view.container"]';
const EDIT_MESSAGE_ICON_SELECTOR =
	'[data-flx="ui.action-menu.context-menu-icons.edit-message-icon.pencil-simple-icon"]';
const REPLY_ICON_SELECTOR = '[data-flx="ui.action-menu.context-menu-icons.reply-icon.arrow-bend-up-left-icon"]';
const QUICK_REACTION_MENU_ITEM_SELECTOR =
	'[data-flx="ui.action-menu.message-context-menu.quick-reaction-context-menu-item.aria-menu-item"]';
const DELETE_ICON_SELECTOR = '[data-flx="ui.action-menu.context-menu-icons.delete-icon.trash-icon"]';
const REPLY_PREVIEW_SELECTOR = '[data-flx^="channel.reply-preview.replied-message"]';

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

function readRequired(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function readRequiredSecret(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
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

function createSessionDiagnostics(label) {
	return {
		label,
		consoleErrors: [],
		expectedOfflineConsoleErrors: [],
		pageErrors: [],
		requestFailures: [],
		expectedOfflineFailures: 0,
		gateway: {
			opened: 0,
			closed: 0,
			active: 0,
			framesReceived: 0,
			framesSent: 0,
		},
	};
}

function isExpectedOfflineConsoleError(message) {
	return (
		message.includes('Failed to save synced preferences: Error: Network error during request') ||
		message === 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED'
	);
}

function attachDiagnostics(page, diagnostics) {
	const state = {expectOfflineFailures: false};
	page.on('console', (message) => {
		if (message.type() !== 'error') return;
		const text = message.text();
		if (state.expectOfflineFailures && isExpectedOfflineConsoleError(text)) {
			diagnostics.expectedOfflineConsoleErrors.push(text);
			return;
		}
		diagnostics.consoleErrors.push(text);
	});
	page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
	page.on('requestfailed', (request) => {
		const error = request.failure()?.errorText ?? 'unknown';
		if (state.expectOfflineFailures && error.includes('ERR_INTERNET_DISCONNECTED')) {
			diagnostics.expectedOfflineFailures += 1;
			return;
		}
		diagnostics.requestFailures.push({url: redactUrl(request.url()), error});
	});
	return state;
}

function attachGatewayDiagnostics(page, diagnostics) {
	const tracker = {opened: 0, current: null};
	page.on('websocket', (socket) => {
		let pathname;
		try {
			pathname = new URL(socket.url()).pathname;
		} catch {
			return;
		}
		if (!pathname.startsWith('/gateway')) return;

		tracker.opened += 1;
		const state = {ordinal: tracker.opened, received: 0, sent: 0, closed: false};
		tracker.current = state;
		diagnostics.gateway.opened += 1;
		diagnostics.gateway.active += 1;
		socket.on('framereceived', () => {
			state.received += 1;
			diagnostics.gateway.framesReceived += 1;
		});
		socket.on('framesent', () => {
			state.sent += 1;
			diagnostics.gateway.framesSent += 1;
		});
		socket.on('close', () => {
			state.closed = true;
			diagnostics.gateway.closed += 1;
			diagnostics.gateway.active = Math.max(0, diagnostics.gateway.active - 1);
		});
	});
	return tracker;
}

async function waitForGatewayReady(page, tracker, timeoutMs, afterOpened = 0) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = tracker.current;
		if (state && state.ordinal > afterOpened && !state.closed && state.received >= 2) {
			return state.ordinal;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`Gateway did not become ready within ${timeoutMs}ms.`);
}

function messageRowById(page, messageId) {
	return page.locator(`${MESSAGE_ROW_SELECTOR}[data-message-id="${messageId}"]`);
}

async function login(page, gatewayTracker, credentials, timeoutMs) {
	const response = await page.goto('/login', {waitUntil: 'domcontentloaded'});
	assert(response, `${credentials.label}: login navigation did not return a response.`);
	assert.equal(response.status(), 200, `${credentials.label}: /login returned HTTP ${response.status()}.`);
	await page.locator('form[name="login"]').waitFor({state: 'visible'});
	await page.locator('input[name="email"]').fill(credentials.email);
	await page.locator('input[name="password"]').fill(credentials.password);
	await page.locator('form[name="login"] button[type="submit"]').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'), {timeout: timeoutMs});
	await page.locator(FRIENDS_VIEW_SELECTOR).waitFor({state: 'visible', timeout: timeoutMs});
	assert.match(page.url(), /\/channels\/@me(?:\/|$)/, `${credentials.label}: login did not reach the Friends area.`);

	const openedBeforeReload = gatewayTracker.opened;
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.locator(FRIENDS_VIEW_SELECTOR).waitFor({state: 'visible', timeout: timeoutMs});
	await waitForGatewayReady(page, gatewayTracker, timeoutMs, openedBeforeReload);
	assert.match(page.url(), /\/channels\/@me(?:\/|$)/, `${credentials.label}: session did not survive reload.`);
}

async function openChannel(page, gatewayTracker, guildId, channelId, timeoutMs) {
	const openedBeforeNavigation = gatewayTracker.opened;
	await page.goto(`/channels/${guildId}/${channelId}`, {waitUntil: 'domcontentloaded'});
	await page.locator(CHANNEL_TEXTAREA_SELECTOR).waitFor({state: 'visible', timeout: timeoutMs});
	await waitForGatewayReady(page, gatewayTracker, timeoutMs, openedBeforeNavigation);
	await page.locator(MESSAGE_HISTORY_READY_SELECTOR).waitFor({state: 'attached', timeout: timeoutMs});
	assert.equal(
		new URL(page.url()).pathname,
		`/channels/${guildId}/${channelId}`,
		'The requested test channel did not open.',
	);
}

async function sendMessage(page, channelId, content, timeoutMs) {
	const textarea = page.locator(CHANNEL_TEXTAREA_SELECTOR).last();
	await textarea.fill(content);
	const responsePromise = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST' &&
			new URL(response.url()).pathname === `/api/v1/channels/${channelId}/messages`,
		{timeout: timeoutMs},
	);
	await textarea.press('Enter');
	const response = await responsePromise;
	assert(response.ok(), `Sending message failed with HTTP ${response.status()}.`);
	const payload = await response.json();
	assert(payload && typeof payload.id === 'string', 'The send-message response did not contain a message ID.');
	const row = messageRowById(page, payload.id).filter({hasText: content});
	await row.waitFor({state: 'visible', timeout: timeoutMs});
	return payload.id;
}

async function sendAttachment(page, channelId, filename, content, timeoutMs, onCreated) {
	const responsePromise = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST' &&
			new URL(response.url()).pathname === `/api/v1/channels/${channelId}/messages`,
		{timeout: timeoutMs},
	);
	await page.evaluate(
		({attachmentFilename, attachmentContent}) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([attachmentContent], attachmentFilename, {type: 'text/plain'}));
			for (const type of ['dragenter', 'dragover', 'drop']) {
				window.dispatchEvent(
					new DragEvent(type, {
						bubbles: true,
						cancelable: true,
						dataTransfer: transfer,
						shiftKey: true,
					}),
				);
			}
		},
		{attachmentFilename: filename, attachmentContent: content},
	);
	const response = await responsePromise;
	assert(response.ok(), `Sending attachment failed with HTTP ${response.status()}.`);
	const payload = await response.json();
	assert(payload && typeof payload.id === 'string', 'The attachment response did not contain a message ID.');
	onCreated(payload.id);
	assert.equal(payload.attachments?.length, 1, 'The attachment response did not contain exactly one attachment.');
	assert.equal(payload.attachments[0].filename, filename, 'The attachment response filename did not match.');
	const attachmentResponse = await page.evaluate(async (url) => {
		const download = await fetch(url);
		return {body: await download.text(), ok: download.ok, status: download.status};
	}, payload.attachments[0].url);
	assert(attachmentResponse.ok, `Downloading the uploaded attachment failed with HTTP ${attachmentResponse.status}.`);
	assert.equal(attachmentResponse.body, content, 'The downloaded attachment content did not match.');
	await messageRowById(page, payload.id).filter({hasText: filename}).waitFor({state: 'visible', timeout: timeoutMs});
	return payload.id;
}

async function openMessageContextMenu(page, messageId, timeoutMs) {
	const row = messageRowById(page, messageId);
	await page.bringToFront();
	await page.locator(CHANNEL_TEXTAREA_SELECTOR).last().click();
	await page.waitForTimeout(100);
	await row.scrollIntoViewIfNeeded();
	await row.click({button: 'right'});
	await page.getByRole('menu').last().waitFor({state: 'visible', timeout: timeoutMs});
}

async function clickMessageContextAction(page, messageId, iconSelector, timeoutMs) {
	await openMessageContextMenu(page, messageId, timeoutMs);
	const menuItem = page
		.getByRole('menuitem')
		.filter({has: page.locator(iconSelector)})
		.last();
	await menuItem.waitFor({state: 'visible', timeout: timeoutMs});
	await menuItem.click();
	if (await menuItem.isVisible()) {
		await page.waitForTimeout(100);
		await menuItem.click();
	}
}

async function deleteMessage(page, messageId, timeoutMs) {
	const row = messageRowById(page, messageId);
	if ((await row.count()) === 0) return;
	await openMessageContextMenu(page, messageId, timeoutMs);
	const deleteMenuItem = page
		.getByRole('menuitem')
		.filter({has: page.locator(DELETE_ICON_SELECTOR)})
		.last();
	await deleteMenuItem.waitFor({state: 'visible', timeout: timeoutMs});
	await deleteMenuItem.click({modifiers: ['Shift']});
	await row.waitFor({state: 'detached', timeout: timeoutMs});
}

const startedAt = new Date().toISOString();
const baseUrl = normalizeBaseUrl(process.env.FLUXER_BROWSER_SMOKE_BASE_URL ?? DEFAULT_LOCAL_URL);
const timeoutMs = readPositiveInteger('FLUXER_BROWSER_SMOKE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
const settleMs = readPositiveInteger('FLUXER_BROWSER_SMOKE_SETTLE_MS', DEFAULT_SETTLE_MS);
const guildId = readRequired('FLUXER_BROWSER_SMOKE_GUILD_ID');
const channelId = readRequired('FLUXER_BROWSER_SMOKE_CHANNEL_ID');
const userA = {
	label: 'user A',
	email: readRequired('FLUXER_BROWSER_SMOKE_USER_A_EMAIL'),
	password: readRequiredSecret('FLUXER_BROWSER_SMOKE_USER_A_PASSWORD'),
};
const userB = {
	label: 'user B',
	email: readRequired('FLUXER_BROWSER_SMOKE_USER_B_EMAIL'),
	password: readRequiredSecret('FLUXER_BROWSER_SMOKE_USER_B_PASSWORD'),
};
const browserChannel =
	process.env.FLUXER_BROWSER_SMOKE_BROWSER_CHANNEL?.trim() || (process.platform === 'win32' ? 'msedge' : null);
const ignoreHTTPSErrors = readBoolean('FLUXER_BROWSER_SMOKE_IGNORE_HTTPS_ERRORS');
const allowProduction = readBoolean('FLUXER_BROWSER_SMOKE_ALLOW_PRODUCTION');
const headless = !readBoolean('FLUXER_BROWSER_SMOKE_HEADED');
const artifactsDirectory = path.resolve(process.env.FLUXER_BROWSER_SMOKE_ARTIFACTS_DIR ?? 'artifacts/browser-smoke');

if (baseUrl.hostname === PRODUCTION_HOSTNAME && !allowProduction) {
	throw new Error(
		'Production collaboration smoke is disabled. Set FLUXER_BROWSER_SMOKE_ALLOW_PRODUCTION=true deliberately.',
	);
}
if (userA.email === userB.email) {
	throw new Error('The collaboration smoke requires two different accounts.');
}

await mkdir(artifactsDirectory, {recursive: true});

const runTag = `browser-collaboration-${Date.now()}`;
const originalContent = `${runTag} original`;
const editedContent = `${runTag} original edited`;
const replyContent = `${runTag} reply`;
const reconnectContent = `${runTag} reconnect`;
const deleteContent = `${runTag} delete`;
const attachmentFilename = `${runTag}.txt`;
const attachmentContent = `${runTag} attachment\n`;
const report = {
	startedAt,
	completedAt: null,
	baseUrl: baseUrl.origin,
	browserChannel,
	browserVersion: null,
	browserInstances: 2,
	headless,
	ignoreHTTPSErrors,
	guildId,
	channelId,
	runTag,
	checks: [],
	cleanup: [],
	diagnostics: [createSessionDiagnostics(userA.label), createSessionDiagnostics(userB.label)],
	status: 'running',
	error: null,
};

function pass(name, details = {}) {
	report.checks.push({name, status: 'passed', ...details});
	console.log(`PASS ${name}`);
}

async function writeReport() {
	report.completedAt = new Date().toISOString();
	const reportPath = path.join(artifactsDirectory, artifactFileName(startedAt, 'collaboration-report.json'));
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	console.log(`Report: ${reportPath}`);
}

let browserA;
let browserB;
let contextA;
let contextB;
let pageA;
let pageB;
let gatewayTrackerA;
let gatewayTrackerB;
let diagnosticsStateA;
let diagnosticsStateB;
const createdMessages = [];

try {
	const launchOptions = {
		...(browserChannel ? {channel: browserChannel} : {}),
		headless,
	};
	[browserA, browserB] = await Promise.all([chromium.launch(launchOptions), chromium.launch(launchOptions)]);
	report.browserVersion = browserA.version();
	contextA = await browserA.newContext({baseURL: baseUrl.origin, ignoreHTTPSErrors, locale: 'en-US'});
	contextB = await browserB.newContext({baseURL: baseUrl.origin, ignoreHTTPSErrors, locale: 'en-US'});
	for (const context of [contextA, contextB]) {
		context.setDefaultTimeout(timeoutMs);
		context.setDefaultNavigationTimeout(timeoutMs);
	}
	pageA = await contextA.newPage();
	pageB = await contextB.newPage();
	diagnosticsStateA = attachDiagnostics(pageA, report.diagnostics[0]);
	diagnosticsStateB = attachDiagnostics(pageB, report.diagnostics[1]);
	gatewayTrackerA = attachGatewayDiagnostics(pageA, report.diagnostics[0]);
	gatewayTrackerB = attachGatewayDiagnostics(pageB, report.diagnostics[1]);

	await Promise.all([login(pageA, gatewayTrackerA, userA, timeoutMs), login(pageB, gatewayTrackerB, userB, timeoutMs)]);
	pass('two isolated sessions authenticate and survive reload');

	await Promise.all([
		openChannel(pageA, gatewayTrackerA, guildId, channelId, timeoutMs),
		openChannel(pageB, gatewayTrackerB, guildId, channelId, timeoutMs),
	]);
	pass('both users open the configured test channel with ready gateway sessions');

	const originalId = await sendMessage(pageA, channelId, originalContent, timeoutMs);
	createdMessages.push({owner: 'A', id: originalId});
	await messageRowById(pageB, originalId).waitFor({state: 'visible', timeout: timeoutMs});
	pass('user B receives user A message live');

	await clickMessageContextAction(pageB, originalId, REPLY_ICON_SELECTOR, timeoutMs);
	const replyId = await sendMessage(pageB, channelId, replyContent, timeoutMs);
	createdMessages.push({owner: 'B', id: replyId});
	const replyOnA = messageRowById(pageA, replyId);
	await replyOnA.waitFor({state: 'visible', timeout: timeoutMs});
	await replyOnA.locator(REPLY_PREVIEW_SELECTOR).waitFor({state: 'visible', timeout: timeoutMs});
	assert(
		await replyOnA.locator(REPLY_PREVIEW_SELECTOR).filter({hasText: originalContent}).count(),
		'Reply did not reference the original message.',
	);
	pass('user A receives user B reply live with the correct reference');

	await clickMessageContextAction(pageA, originalId, EDIT_MESSAGE_ICON_SELECTOR, timeoutMs);
	const editInput = pageA.getByRole('textbox', {name: 'Edit message'}).last();
	await editInput.waitFor({state: 'visible', timeout: timeoutMs});
	await editInput.fill(editedContent);
	await pageA.getByRole('button', {name: 'save', exact: true}).last().click();
	await messageRowById(pageB, originalId)
		.filter({hasText: editedContent})
		.waitFor({state: 'visible', timeout: timeoutMs});
	pass('user B receives user A edit live');

	await openMessageContextMenu(pageB, originalId, timeoutMs);
	await pageB.locator(QUICK_REACTION_MENU_ITEM_SELECTOR).first().click();
	await pageA
		.locator(`${MESSAGE_ROW_SELECTOR}[data-message-id="${originalId}"]`)
		.getByRole('button', {name: /1 reaction/i})
		.waitFor({state: 'visible', timeout: timeoutMs});
	pass('user A receives user B reaction live');

	const attachmentId = await sendAttachment(
		pageA,
		channelId,
		attachmentFilename,
		attachmentContent,
		timeoutMs,
		(id) => {
			createdMessages.push({owner: 'A', id});
		},
	);
	await messageRowById(pageB, attachmentId)
		.filter({hasText: attachmentFilename})
		.waitFor({state: 'visible', timeout: timeoutMs});
	pass('user B receives user A attachment live and its stored bytes match', {filename: attachmentFilename});

	const gatewayConnectionsBeforeOffline = gatewayTrackerB.opened;
	diagnosticsStateB.expectOfflineFailures = true;
	await contextB.setOffline(true);
	await pageB.waitForTimeout(settleMs);
	const reconnectId = await sendMessage(pageA, channelId, reconnectContent, timeoutMs);
	createdMessages.push({owner: 'A', id: reconnectId});
	await contextB.setOffline(false);
	diagnosticsStateB.expectOfflineFailures = false;
	await pageB.bringToFront();
	await messageRowById(pageB, reconnectId).waitFor({state: 'visible', timeout: timeoutMs});
	pass('user B gateway session catches up after going offline and online', {
		connection: gatewayTrackerB.opened > gatewayConnectionsBeforeOffline ? 'reopened' : 'reused',
	});

	await openChannel(pageB, gatewayTrackerB, guildId, channelId, timeoutMs);
	await messageRowById(pageB, originalId)
		.filter({hasText: editedContent})
		.waitFor({state: 'visible', timeout: timeoutMs});
	await messageRowById(pageB, originalId)
		.getByRole('button', {name: /1 reaction/i})
		.waitFor({state: 'visible', timeout: timeoutMs});
	await messageRowById(pageB, replyId)
		.locator(REPLY_PREVIEW_SELECTOR)
		.filter({hasText: editedContent})
		.waitFor({state: 'visible', timeout: timeoutMs});
	await messageRowById(pageB, attachmentId)
		.filter({hasText: attachmentFilename})
		.waitFor({state: 'visible', timeout: timeoutMs});
	pass('channel reload preserves edit, reply, reaction, and attachment state');

	const deleteId = await sendMessage(pageA, channelId, deleteContent, timeoutMs);
	createdMessages.push({owner: 'A', id: deleteId});
	await messageRowById(pageB, deleteId).waitFor({state: 'visible', timeout: timeoutMs});
	await deleteMessage(pageA, deleteId, timeoutMs);
	createdMessages.pop();
	report.cleanup.push({messageId: deleteId, status: 'deleted'});
	await messageRowById(pageB, deleteId).waitFor({state: 'detached', timeout: timeoutMs});
	pass('user B receives user A message deletion live');

	report.status = 'passed';
} catch (error) {
	report.status = 'failed';
	report.error = error instanceof Error ? error.message : String(error);
	console.error(`FAIL ${report.error}`);
	for (const [label, page] of [
		['user-a', pageA],
		['user-b', pageB],
	]) {
		if (!page) continue;
		const emailInput = page.locator('input[name="email"]');
		if (await emailInput.count()) await emailInput.fill('', {timeout: 1_000}).catch(() => undefined);
		const passwordInput = page.locator('input[name="password"]');
		if (await passwordInput.count()) await passwordInput.fill('', {timeout: 1_000}).catch(() => undefined);
		await page
			.screenshot({
				path: path.join(artifactsDirectory, artifactFileName(startedAt, `${label}-collaboration-failure.png`)),
				fullPage: true,
				timeout: 5_000,
			})
			.catch(() => undefined);
	}
	process.exitCode = 1;
} finally {
	if (contextB) await contextB.setOffline(false).catch(() => undefined);
	if (diagnosticsStateA) diagnosticsStateA.expectOfflineFailures = false;
	if (diagnosticsStateB) diagnosticsStateB.expectOfflineFailures = false;
	for (const message of [...createdMessages].reverse()) {
		const ownerPage = message.owner === 'A' ? pageA : pageB;
		if (!ownerPage) continue;
		try {
			const ownerTracker = message.owner === 'A' ? gatewayTrackerA : gatewayTrackerB;
			if (new URL(ownerPage.url()).pathname !== `/channels/${guildId}/${channelId}`) {
				await openChannel(ownerPage, ownerTracker, guildId, channelId, timeoutMs);
			}
			await deleteMessage(ownerPage, message.id, timeoutMs);
			report.cleanup.push({messageId: message.id, status: 'deleted'});
			console.log(`CLEANUP deleted ${message.id}`);
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			report.cleanup.push({messageId: message.id, status: 'failed', error: messageText});
			report.status = 'failed';
			report.error ??= 'One or more test messages could not be deleted.';
			process.exitCode = 1;
			console.error(`CLEANUP failed ${message.id}: ${messageText}`);
		}
	}
	if (report.status === 'passed') {
		try {
			await pageA.waitForTimeout(settleMs);
			assert.deepEqual(report.diagnostics[0].pageErrors, [], 'User A page emitted runtime errors.');
			assert.deepEqual(report.diagnostics[1].pageErrors, [], 'User B page emitted runtime errors.');
			assert.deepEqual(report.diagnostics[0].consoleErrors, [], 'User A page emitted console errors.');
			assert.deepEqual(report.diagnostics[1].consoleErrors, [], 'User B page emitted console errors.');
			assert.deepEqual(report.diagnostics[0].requestFailures, [], 'User A page emitted unexpected request failures.');
			assert.deepEqual(report.diagnostics[1].requestFailures, [], 'User B page emitted unexpected request failures.');
			pass('neither page emitted uncaught errors or unexpected request failures');
		} catch (error) {
			report.status = 'failed';
			report.error = error instanceof Error ? error.message : String(error);
			process.exitCode = 1;
			console.error(`FAIL ${report.error}`);
		}
	}
	await Promise.all([browserA?.close().catch(() => undefined), browserB?.close().catch(() => undefined)]);
	await writeReport();
}
