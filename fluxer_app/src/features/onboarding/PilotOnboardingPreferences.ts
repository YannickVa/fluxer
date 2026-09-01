// SPDX-License-Identifier: AGPL-3.0-or-later

import type {PilotOnboardingProgress} from '@app/features/onboarding/PilotOnboardingState';
import {EMPTY_PILOT_ONBOARDING_PROGRESS} from '@app/features/onboarding/PilotOnboardingState';
import UserSettings from '@app/features/user/state/UserSettings';
import {create} from '@bufbuild/protobuf';
import {
	type InstanceOnboardingState,
	InstanceOnboardingStateSchema,
} from '@fluxer/schema/src/gen/fluxer/user/preferences/v1/preferences_pb';

export function pilotOnboardingProgressFromPreference(
	preference: InstanceOnboardingState | undefined,
): PilotOnboardingProgress {
	if (!preference) return EMPTY_PILOT_ONBOARDING_PROGRESS;
	return {
		completedVersion: preference.completedVersion,
		dismissedVersion: preference.dismissedVersion,
		acknowledgedStepIds: Array.from(new Set(preference.acknowledgedStepIds)),
	};
}

export function pilotOnboardingProgressToPreference(progress: PilotOnboardingProgress): InstanceOnboardingState {
	return create(InstanceOnboardingStateSchema, {
		completedVersion: progress.completedVersion,
		dismissedVersion: progress.dismissedVersion,
		acknowledgedStepIds: Array.from(new Set(progress.acknowledgedStepIds)),
	});
}

export function getPilotOnboardingProgress(): PilotOnboardingProgress {
	return pilotOnboardingProgressFromPreference(UserSettings.getSubPreference('instanceOnboarding'));
}

export async function setPilotOnboardingProgress(progress: PilotOnboardingProgress): Promise<void> {
	await UserSettings.setSubPreference('instanceOnboarding', pilotOnboardingProgressToPreference(progress));
}
