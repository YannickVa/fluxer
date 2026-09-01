// SPDX-License-Identifier: AGPL-3.0-or-later

import {create} from '@bufbuild/protobuf';
import {InstanceOnboardingStateSchema} from '@fluxer/schema/src/gen/fluxer/user/preferences/v1/preferences_pb';
import {describe, expect, it, vi} from 'vitest';
import {pilotOnboardingProgressFromPreference, pilotOnboardingProgressToPreference} from './PilotOnboardingPreferences';
import {EMPTY_PILOT_ONBOARDING_PROGRESS} from './PilotOnboardingState';

vi.mock('@app/features/user/state/UserSettings', () => ({
	default: {
		getSubPreference: vi.fn(),
		setSubPreference: vi.fn(),
	},
}));

describe('PilotOnboardingPreferences', () => {
	it('returns an immutable empty progress value when no preference exists', () => {
		expect(pilotOnboardingProgressFromPreference(undefined)).toBe(EMPTY_PILOT_ONBOARDING_PROGRESS);
	});

	it('deduplicates acknowledged steps in both conversion directions', () => {
		const preference = create(InstanceOnboardingStateSchema, {
			completedVersion: 2,
			dismissedVersion: 1,
			acknowledgedStepIds: ['profile', 'profile', 'media'],
		});
		const progress = pilotOnboardingProgressFromPreference(preference);
		expect(progress).toEqual({
			completedVersion: 2,
			dismissedVersion: 1,
			acknowledgedStepIds: ['profile', 'media'],
		});
		expect(
			pilotOnboardingProgressToPreference({
				...progress,
				acknowledgedStepIds: ['profile', 'profile', 'media'],
			}).acknowledgedStepIds,
		).toEqual(['profile', 'media']);
	});
});
