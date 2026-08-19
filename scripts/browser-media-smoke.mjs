// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {chromium} from 'playwright';

const DEFAULT_LOCAL_URL = 'http://localhost:8088';
const PRODUCTION_HOSTNAME = 'matskos.duckdns.org';
const DEFAULT_TIMEOUT_MS = 45_000;
const FRIENDS_VIEW_SELECTOR = '[data-flx="channel.direct-message.dm-friends-view.container"]';
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
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
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

function redactSensitiveText(value, sensitiveValues) {
	let redacted = String(value);
	for (const sensitiveValue of sensitiveValues) {
		if (sensitiveValue) redacted = redacted.replaceAll(sensitiveValue, '<redacted>');
	}
	return redacted;
}

function redactUrl(value, sensitiveValues) {
	try {
		const url = new URL(value);
		url.search = '';
		url.hash = '';
		return redactSensitiveText(url.href, sensitiveValues);
	} catch {
		return '<non-http request>';
	}
}

function createDiagnostics(label) {
	return {label, consoleErrors: [], pageErrors: [], requestFailures: []};
}

function attachDiagnostics(page, diagnostics, sensitiveValues) {
	page.on('console', (message) => {
		if (message.type() === 'error') {
			diagnostics.consoleErrors.push(redactSensitiveText(message.text(), sensitiveValues));
		}
	});
	page.on('pageerror', (error) => diagnostics.pageErrors.push(redactSensitiveText(error.message, sensitiveValues)));
	page.on('requestfailed', (request) => {
		diagnostics.requestFailures.push({
			url: redactUrl(request.url(), sensitiveValues),
			error: redactSensitiveText(request.failure()?.errorText ?? 'unknown', sensitiveValues),
		});
	});
}

function createY4m({width = 160, height = 120, fps = 10, frameCount = 300, y, u, v}) {
	assert.equal(width % 2, 0);
	assert.equal(height % 2, 0);
	const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`, 'ascii');
	const frameHeader = Buffer.from('FRAME\n', 'ascii');
	const frame = Buffer.concat([
		Buffer.alloc(width * height, y),
		Buffer.alloc((width * height) / 4, u),
		Buffer.alloc((width * height) / 4, v),
	]);
	const chunks = [header];
	for (let index = 0; index < frameCount; index += 1) chunks.push(frameHeader, frame);
	return Buffer.concat(chunks);
}

function createWav({frequency, durationSeconds = 30, sampleRate = 48_000, amplitude = 0.25}) {
	const sampleCount = sampleRate * durationSeconds;
	const bytesPerSample = 2;
	const dataSize = sampleCount * bytesPerSample;
	const wav = Buffer.alloc(44 + dataSize);
	wav.write('RIFF', 0, 'ascii');
	wav.writeUInt32LE(36 + dataSize, 4);
	wav.write('WAVE', 8, 'ascii');
	wav.write('fmt ', 12, 'ascii');
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
	wav.writeUInt16LE(bytesPerSample, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36, 'ascii');
	wav.writeUInt32LE(dataSize, 40);
	for (let index = 0; index < sampleCount; index += 1) {
		const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude;
		wav.writeInt16LE(Math.round(sample * 32_767), 44 + index * bytesPerSample);
	}
	return wav;
}

async function createCaptureFixtures() {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'fluxer-media-smoke-'));
	const fixtures = {
		directory,
		userA: {
			video: path.join(directory, 'user-a.y4m'),
			audio: path.join(directory, 'user-a.wav'),
		},
		userB: {
			video: path.join(directory, 'user-b.y4m'),
			audio: path.join(directory, 'user-b.wav'),
		},
	};
	await Promise.all([
		writeFile(fixtures.userA.video, createY4m({y: 145, u: 54, v: 193})),
		writeFile(fixtures.userB.video, createY4m({y: 110, u: 202, v: 81})),
		writeFile(fixtures.userA.audio, createWav({frequency: 440})),
		writeFile(fixtures.userB.audio, createWav({frequency: 660})),
	]);
	return fixtures;
}

function installRtcTracker() {
	const peers = [];
	Object.defineProperty(window, '__fluxerMediaSmokePeers', {value: peers, configurable: false});
	const NativeRTCPeerConnection = window.RTCPeerConnection;
	class TrackedRTCPeerConnection extends NativeRTCPeerConnection {
		constructor(...args) {
			super(...args);
			peers.push(this);
		}
	}
	window.RTCPeerConnection = TrackedRTCPeerConnection;
}

async function collectRtcStats(page) {
	return await page.evaluate(async () => {
		const totals = {
			peerConnections: 0,
			outboundAudioBytes: 0,
			outboundAudioPackets: 0,
			outboundVideoBytes: 0,
			outboundVideoPackets: 0,
			outboundVideoFrames: 0,
			inboundAudioBytes: 0,
			inboundAudioPackets: 0,
			inboundVideoBytes: 0,
			inboundVideoPackets: 0,
			inboundVideoFrames: 0,
		};
		const peers = window.__fluxerMediaSmokePeers ?? [];
		totals.peerConnections = peers.length;
		for (const peer of peers) {
			const stats = await peer.getStats();
			for (const entry of stats.values()) {
				if (entry.isRemote) continue;
				const kind = entry.kind ?? entry.mediaType;
				if (entry.type === 'outbound-rtp' && kind === 'audio') {
					totals.outboundAudioBytes += entry.bytesSent ?? 0;
					totals.outboundAudioPackets += entry.packetsSent ?? 0;
				} else if (entry.type === 'outbound-rtp' && kind === 'video') {
					totals.outboundVideoBytes += entry.bytesSent ?? 0;
					totals.outboundVideoPackets += entry.packetsSent ?? 0;
					totals.outboundVideoFrames += entry.framesEncoded ?? 0;
				} else if (entry.type === 'inbound-rtp' && kind === 'audio') {
					totals.inboundAudioBytes += entry.bytesReceived ?? 0;
					totals.inboundAudioPackets += entry.packetsReceived ?? 0;
				} else if (entry.type === 'inbound-rtp' && kind === 'video') {
					totals.inboundVideoBytes += entry.bytesReceived ?? 0;
					totals.inboundVideoPackets += entry.packetsReceived ?? 0;
					totals.inboundVideoFrames += entry.framesDecoded ?? 0;
				}
			}
		}
		return totals;
	});
}

function hasBidirectionalMedia(stats) {
	return (
		stats.peerConnections > 0 &&
		stats.outboundAudioBytes > 0 &&
		stats.outboundAudioPackets > 0 &&
		stats.outboundVideoBytes > 0 &&
		stats.outboundVideoPackets > 0 &&
		stats.outboundVideoFrames > 0 &&
		stats.inboundAudioBytes > 0 &&
		stats.inboundAudioPackets > 0 &&
		stats.inboundVideoBytes > 0 &&
		stats.inboundVideoPackets > 0 &&
		stats.inboundVideoFrames > 0
	);
}

async function waitForBidirectionalMedia(page, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let latest = await collectRtcStats(page);
	while (Date.now() < deadline) {
		latest = await collectRtcStats(page);
		if (hasBidirectionalMedia(latest)) return latest;
		await page.waitForTimeout(250);
	}
	throw new Error(
		`Bidirectional audio/video RTP did not become active within ${timeoutMs}ms: ${JSON.stringify(latest)}`,
	);
}

async function login(page, credentials, timeoutMs) {
	const response = await page.goto('/login', {waitUntil: 'domcontentloaded'});
	assert(response, `${credentials.label}: login navigation did not return a response.`);
	assert.equal(response.status(), 200, `${credentials.label}: /login returned HTTP ${response.status()}.`);
	await page.locator('form[name="login"]').waitFor({state: 'visible'});
	await page.locator('input[name="email"]').fill(credentials.email);
	await page.locator('input[name="password"]').fill(credentials.password);
	await page.locator('form[name="login"] button[type="submit"]').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'), {timeout: timeoutMs});
	await page.locator(FRIENDS_VIEW_SELECTOR).waitFor({state: 'visible', timeout: timeoutMs});
}

async function enableAudioPlaybackIfPrompted(page) {
	const modal = page.locator('[data-flx="voice.audio-playback-permission-modal.confirm-modal"]');
	if (await modal.isVisible().catch(() => false)) {
		await modal.getByRole('button', {name: /enable audio/i}).click();
	}
}

async function joinVoiceChannel(page, guildId, voiceChannelId, timeoutMs) {
	await page.goto(`/channels/${guildId}/${voiceChannelId}`, {waitUntil: 'domcontentloaded'});
	const channelRow = page.locator(`[data-scroll-id="channel-${voiceChannelId}"]`);
	await channelRow.waitFor({state: 'visible', timeout: timeoutMs});
	await channelRow.click();
	const userControls = page.getByRole('region', {name: /^user controls$/i});
	const disconnectButton = userControls.getByRole('button', {name: /^disconnect$/i});
	try {
		await disconnectButton.waitFor({state: 'visible', timeout: Math.min(8_000, timeoutMs)});
	} catch {
		await channelRow.dblclick();
		await disconnectButton.waitFor({state: 'visible', timeout: timeoutMs});
	}
	await enableAudioPlaybackIfPrompted(page);
	const cameraButton = userControls.getByRole('button', {name: /^(turn on|turn off) camera$/i});
	await cameraButton.waitFor({state: 'visible', timeout: timeoutMs});
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !(await cameraButton.isEnabled())) await page.waitForTimeout(50);
	assert(await cameraButton.isEnabled(), 'camera control did not become enabled after joining voice.');
}

async function ensureMicrophoneUnmuted(page, timeoutMs) {
	const userControls = page.getByRole('region', {name: /^user controls$/i});
	const button = userControls.getByRole('button', {name: /^(mute|unmute) microphone$/i});
	await button.waitFor({state: 'visible', timeout: timeoutMs});
	const label = await button.getAttribute('aria-label');
	if (/^unmute microphone$/i.test(label ?? '')) await button.click();
	await userControls.getByRole('button', {name: /^mute microphone$/i}).waitFor({
		state: 'visible',
		timeout: timeoutMs,
	});
}

async function assertButtonPressed(button, expected, label, timeoutMs) {
	const expectedValue = String(expected);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && (await button.getAttribute('aria-pressed')) !== expectedValue) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(
		await button.getAttribute('aria-pressed'),
		expectedValue,
		`${label} did not reach aria-pressed=${expectedValue}.`,
	);
}

async function enableCamera(page, timeoutMs) {
	const userControls = page.getByRole('region', {name: /^user controls$/i});
	const cameraButton = userControls.getByRole('button', {name: /^(turn on|turn off) camera$/i});
	await cameraButton.waitFor({state: 'visible', timeout: timeoutMs});
	if ((await cameraButton.getAttribute('aria-pressed')) === 'true') return;
	await cameraButton.click();
	const dialog = page.getByRole('dialog');
	await dialog.waitFor({state: 'visible', timeout: timeoutMs});
	const preview = dialog.locator('video');
	await preview.waitFor({state: 'visible', timeout: timeoutMs});
	const deadline = Date.now() + timeoutMs;
	let previewReady = false;
	while (Date.now() < deadline) {
		previewReady = await preview.evaluate(
			(video) =>
				video instanceof HTMLVideoElement && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0,
		);
		if (previewReady) break;
		await page.waitForTimeout(50);
	}
	assert(previewReady, 'camera preview did not produce a decoded video frame.');
	await dialog.getByRole('button', {name: /^(enable|turn on) camera$/i}).click();
	await assertButtonPressed(cameraButton, true, 'camera control', timeoutMs);
}

async function disconnect(page) {
	const button = page.getByRole('region', {name: /^user controls$/i}).getByRole('button', {name: /^disconnect$/i});
	if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined);
}

const startedAt = new Date().toISOString();
const baseUrl = normalizeBaseUrl(process.env.FLUXER_BROWSER_SMOKE_BASE_URL ?? DEFAULT_LOCAL_URL);
const timeoutMs = readPositiveInteger('FLUXER_BROWSER_SMOKE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
const guildId = readRequired('FLUXER_BROWSER_SMOKE_GUILD_ID');
const voiceChannelId = readRequired('FLUXER_BROWSER_SMOKE_VOICE_CHANNEL_ID');
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
const sensitiveValues = [userA.email, userA.password, userB.email, userB.password];
const browserChannel =
	process.env.FLUXER_BROWSER_SMOKE_BROWSER_CHANNEL?.trim() || (process.platform === 'win32' ? 'msedge' : null);
const ignoreHTTPSErrors = readBoolean('FLUXER_BROWSER_SMOKE_IGNORE_HTTPS_ERRORS');
const allowProduction = readBoolean('FLUXER_BROWSER_SMOKE_ALLOW_PRODUCTION');
const headless = !readBoolean('FLUXER_BROWSER_SMOKE_HEADED');
const artifactsDirectory = path.resolve(process.env.FLUXER_BROWSER_SMOKE_ARTIFACTS_DIR ?? 'artifacts/browser-smoke');

if (baseUrl.hostname === PRODUCTION_HOSTNAME && !allowProduction) {
	throw new Error('Production media smoke is disabled. Set FLUXER_BROWSER_SMOKE_ALLOW_PRODUCTION=true deliberately.');
}
if (userA.email === userB.email) throw new Error('The media smoke requires two different accounts.');

await mkdir(artifactsDirectory, {recursive: true});
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
	voiceChannelId,
	fixtures: {
		video: {format: 'Y4M I420', width: 160, height: 120, fps: 10, frames: 300},
		audio: {format: 'PCM WAV', sampleRate: 48_000, durationSeconds: 30, frequenciesHz: [440, 660]},
	},
	checks: [],
	diagnostics: [createDiagnostics(userA.label), createDiagnostics(userB.label)],
	rtc: null,
	status: 'running',
	error: null,
};

function pass(name, details = {}) {
	report.checks.push({name, status: 'passed', ...details});
	console.log(`PASS ${name}`);
}

async function writeReport() {
	report.completedAt = new Date().toISOString();
	const reportPath = path.join(artifactsDirectory, artifactFileName(startedAt, 'media-report.json'));
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	console.log(`Report: ${reportPath}`);
}

let fixtures;
let browserA;
let browserB;
let contextA;
let contextB;
let pageA;
let pageB;

try {
	fixtures = await createCaptureFixtures();
	const launch = (capture) =>
		chromium.launch({
			...(browserChannel ? {channel: browserChannel} : {}),
			headless,
			args: [
				'--autoplay-policy=no-user-gesture-required',
				'--use-fake-device-for-media-stream',
				'--use-fake-ui-for-media-stream',
				`--use-file-for-fake-video-capture=${capture.video}`,
				`--use-file-for-fake-audio-capture=${capture.audio}`,
			],
		});
	[browserA, browserB] = await Promise.all([launch(fixtures.userA), launch(fixtures.userB)]);
	report.browserVersion = browserA.version();
	contextA = await browserA.newContext({
		baseURL: baseUrl.origin,
		ignoreHTTPSErrors,
		locale: 'en-US',
		permissions: ['camera', 'microphone'],
	});
	contextB = await browserB.newContext({
		baseURL: baseUrl.origin,
		ignoreHTTPSErrors,
		locale: 'en-US',
		permissions: ['camera', 'microphone'],
	});
	await Promise.all([contextA.addInitScript(installRtcTracker), contextB.addInitScript(installRtcTracker)]);
	for (const context of [contextA, contextB]) {
		context.setDefaultTimeout(timeoutMs);
		context.setDefaultNavigationTimeout(timeoutMs);
	}
	pageA = await contextA.newPage();
	pageB = await contextB.newPage();
	attachDiagnostics(pageA, report.diagnostics[0], sensitiveValues);
	attachDiagnostics(pageB, report.diagnostics[1], sensitiveValues);

	await Promise.all([login(pageA, userA, timeoutMs), login(pageB, userB, timeoutMs)]);
	pass('two isolated sessions authenticate');

	await Promise.all([
		joinVoiceChannel(pageA, guildId, voiceChannelId, timeoutMs),
		joinVoiceChannel(pageB, guildId, voiceChannelId, timeoutMs),
	]);
	pass('both users join the configured voice channel');

	await Promise.all([ensureMicrophoneUnmuted(pageA, timeoutMs), ensureMicrophoneUnmuted(pageB, timeoutMs)]);
	pass('both deterministic fake microphones are unmuted');

	await Promise.all([enableCamera(pageA, timeoutMs), enableCamera(pageB, timeoutMs)]);
	pass('both deterministic fake cameras preview and publish');

	const [statsA, statsB] = await Promise.all([
		waitForBidirectionalMedia(pageA, timeoutMs),
		waitForBidirectionalMedia(pageB, timeoutMs),
	]);
	report.rtc = {userA: statsA, userB: statsB};
	pass('both sessions send and receive audio and video RTP', {userA: statsA, userB: statsB});

	for (const diagnostics of report.diagnostics) {
		assert.deepEqual(diagnostics.pageErrors, [], `${diagnostics.label} emitted page errors.`);
		assert.deepEqual(diagnostics.consoleErrors, [], `${diagnostics.label} emitted console errors.`);
		assert.deepEqual(diagnostics.requestFailures, [], `${diagnostics.label} emitted request failures.`);
	}
	pass('neither page emitted uncaught errors or failed requests');
	report.status = 'passed';
} catch (error) {
	report.status = 'failed';
	report.error = redactSensitiveText(error instanceof Error ? error.message : String(error), sensitiveValues);
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
				path: path.join(artifactsDirectory, artifactFileName(startedAt, `${label}-media-failure.png`)),
				fullPage: true,
				timeout: 5_000,
			})
			.catch(() => undefined);
	}
	process.exitCode = 1;
} finally {
	await Promise.all([disconnect(pageA).catch(() => undefined), disconnect(pageB).catch(() => undefined)]);
	await Promise.all([browserA?.close().catch(() => undefined), browserB?.close().catch(() => undefined)]);
	if (fixtures?.directory) await rm(fixtures.directory, {recursive: true, force: true});
	await writeReport();
}
