// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createSupportDiagnosticsSnapshot,
	getHealthCheckUrl,
	getOverallSupportStatus,
	getSafeOrigin,
	runEndpointHealthCheck,
	serializeSupportDiagnostics,
} from '@app/features/support/SupportCenterDiagnostics';
import {describe, expect, test} from 'vitest';

describe('SupportCenterDiagnostics', () => {
	test('builds a health URL without carrying query data', () => {
		expect(getHealthCheckUrl('https://chat.example/api/?token=secret#section')).toBe(
			'https://chat.example/api/_health',
		);
		expect(getHealthCheckUrl('not a URL')).toBeNull();
	});

	test('keeps only the origin when identifying an instance', () => {
		expect(getSafeOrigin('https://chat.example/api?token=secret')).toBe('https://chat.example');
		expect(getSafeOrigin('invalid')).toBe('unknown');
	});

	test('uses the most urgent readiness state', () => {
		expect(
			getOverallSupportStatus([
				{id: 'instance', status: 'pass'},
				{id: 'devices', status: 'warning'},
				{id: 'update', status: 'neutral'},
			]),
		).toBe('warning');
		expect(
			getOverallSupportStatus([
				{id: 'instance', status: 'fail'},
				{id: 'devices', status: 'checking'},
			]),
		).toBe('checking');
	});

	test('records a health response without reading or storing its body', async () => {
		let bodyRead = false;
		const check = await runEndpointHealthCheck('api', 'https://chat.example/api', {
			fetchImpl: async () =>
				({
					ok: true,
					status: 200,
					text: async () => {
						bodyRead = true;
						return 'sensitive server details';
					},
				}) as Response,
		});
		expect(check).toMatchObject({service: 'api', status: 'pass', httpStatus: 200, error: null});
		expect(bodyRead).toBe(false);
	});

	test('serializes only the allow-listed support fields', () => {
		const snapshot = createSupportDiagnosticsSnapshot({
			generatedAt: new Date('2026-08-20T12:00:00.000Z'),
			product: {
				name: 'Fluxer',
				instanceOrigin: 'https://chat.example',
				selfHosted: true,
				voiceEnabled: true,
			},
			build: {webVersion: 'abc123', releaseChannel: 'stable', desktopVersion: '1.2.3', desktopChannel: 'stable'},
			client: {
				os: 'Windows',
				osVersion: '11',
				architecture: 'x64',
				browser: 'Electron',
				browserVersion: '1',
				desktop: true,
			},
			connectivity: {browserOnline: true, gateway: 'ready', checks: []},
			media: {
				microphonePermission: 'granted',
				cameraPermission: 'prompt',
				inputDeviceCount: 1,
				outputDeviceCount: 1,
				cameraDeviceCount: 1,
				voiceSession: 'not-connected',
				connectionQuality: null,
				latencyMs: null,
			},
			update: {
				state: 'idle',
				currentVersion: '1.2.3',
				availableVersion: null,
				channel: 'stable',
				lastCheckedAt: null,
				updateAvailable: false,
				downloadReady: false,
				unsupportedReason: null,
			},
		});
		const serialized = serializeSupportDiagnostics(snapshot);
		expect(serialized).toContain('"schemaVersion": 1');
		expect(serialized).not.toMatch(/token|cookie|messageContent|channelId|guildId|userId|deviceId/i);
	});
});
