// SPDX-License-Identifier: AGPL-3.0-or-later

import AppStorage from '@app/features/platform/state/PersistentStorage';

export interface PilotOnboardingDeviceState {
	notificationTested: boolean;
	mediaChecked: boolean;
}

export const EMPTY_PILOT_ONBOARDING_DEVICE_STATE: PilotOnboardingDeviceState = Object.freeze({
	notificationTested: false,
	mediaChecked: false,
});

function getStorageKey(instanceDomain: string, userId: string, version: number): string {
	return `pilot-onboarding-device:${encodeURIComponent(instanceDomain)}:${userId}:v${version}`;
}

export function parsePilotOnboardingDeviceState(value: unknown): PilotOnboardingDeviceState {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return EMPTY_PILOT_ONBOARDING_DEVICE_STATE;
	}
	const record = value as Record<string, unknown>;
	return {
		notificationTested: record.notificationTested === true,
		mediaChecked: record.mediaChecked === true,
	};
}

export function getPilotOnboardingDeviceState(input: {
	instanceDomain: string;
	userId: string;
	version: number;
}): PilotOnboardingDeviceState {
	return parsePilotOnboardingDeviceState(
		AppStorage.getJSON<unknown>(getStorageKey(input.instanceDomain, input.userId, input.version)),
	);
}

export function setPilotOnboardingDeviceState(
	input: {instanceDomain: string; userId: string; version: number},
	state: PilotOnboardingDeviceState,
): void {
	AppStorage.setJSON(getStorageKey(input.instanceDomain, input.userId, input.version), state);
}
