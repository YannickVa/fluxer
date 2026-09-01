// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

const storage = new Map<string, unknown>();

vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {
		getJSON: (key: string) => storage.get(key) ?? null,
		setJSON: (key: string, value: unknown) => storage.set(key, value),
	},
}));

import {
	getPilotOnboardingDeviceState,
	parsePilotOnboardingDeviceState,
	setPilotOnboardingDeviceState,
} from './PilotOnboardingDeviceState';

describe('PilotOnboardingDeviceState', () => {
	it('returns safe defaults for malformed values', () => {
		expect(parsePilotOnboardingDeviceState('bad')).toEqual({notificationTested: false, mediaChecked: false});
		expect(parsePilotOnboardingDeviceState({notificationTested: true})).toEqual({
			notificationTested: true,
			mediaChecked: false,
		});
	});

	it('scopes checks by instance, user, and onboarding version', () => {
		setPilotOnboardingDeviceState(
			{instanceDomain: 'chat.example.test', userId: '1', version: 2},
			{notificationTested: true, mediaChecked: true},
		);

		expect(getPilotOnboardingDeviceState({instanceDomain: 'chat.example.test', userId: '1', version: 2})).toEqual({
			notificationTested: true,
			mediaChecked: true,
		});
		expect(getPilotOnboardingDeviceState({instanceDomain: 'chat.example.test', userId: '1', version: 3})).toEqual({
			notificationTested: false,
			mediaChecked: false,
		});
	});
});
