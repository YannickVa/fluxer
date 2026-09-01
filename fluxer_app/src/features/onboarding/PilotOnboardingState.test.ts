// SPDX-License-Identifier: AGPL-3.0-or-later

import type {InstanceOnboarding} from '@fluxer/instance_bootstrap/src/Types';
import {describe, expect, it} from 'vitest';
import {
	acknowledgePilotOnboardingStep,
	completePilotOnboarding,
	dismissPilotOnboarding,
	EMPTY_PILOT_ONBOARDING_PROGRESS,
	getEnabledPilotOnboardingSteps,
	shouldAutoOpenPilotOnboarding,
} from './PilotOnboardingState';

const CONFIG: InstanceOnboarding = {
	enabled: true,
	version: 2,
	enabled_at: '2026-09-01T10:00:00.000Z',
	show_for_existing_users: false,
	welcome_message: null,
	operator_name: null,
	availability_message: null,
	primary_guild_id: null,
	rules_channel_id: null,
	introduction_channel_id: null,
	mfa_policy: 'recommended',
	steps: {
		profile: true,
		security: true,
		notifications: false,
		media: true,
		community: true,
	},
};

describe('PilotOnboardingState', () => {
	it('auto-opens only for eligible new accounts when existing users are excluded', () => {
		expect(
			shouldAutoOpenPilotOnboarding({
				config: CONFIG,
				progress: EMPTY_PILOT_ONBOARDING_PROGRESS,
				userCreatedAt: new Date('2026-09-01T10:00:01.000Z'),
			}),
		).toBe(true);
		expect(
			shouldAutoOpenPilotOnboarding({
				config: CONFIG,
				progress: EMPTY_PILOT_ONBOARDING_PROGRESS,
				userCreatedAt: new Date('2026-09-01T09:59:59.000Z'),
			}),
		).toBe(false);
	});

	it('never auto-opens disabled or invalidly dated onboarding', () => {
		expect(
			shouldAutoOpenPilotOnboarding({
				config: {...CONFIG, enabled: false},
				progress: EMPTY_PILOT_ONBOARDING_PROGRESS,
				userCreatedAt: new Date('2026-09-02T00:00:00.000Z'),
			}),
		).toBe(false);
		expect(
			shouldAutoOpenPilotOnboarding({
				config: {...CONFIG, enabled_at: 'invalid'},
				progress: EMPTY_PILOT_ONBOARDING_PROGRESS,
				userCreatedAt: new Date('2026-09-02T00:00:00.000Z'),
			}),
		).toBe(false);
	});

	it('respects completion and dismissal for the current version', () => {
		const existingUserConfig = {...CONFIG, show_for_existing_users: true};
		const userCreatedAt = new Date('2020-01-01T00:00:00.000Z');
		expect(
			shouldAutoOpenPilotOnboarding({
				config: existingUserConfig,
				progress: completePilotOnboarding(EMPTY_PILOT_ONBOARDING_PROGRESS, 2),
				userCreatedAt,
			}),
		).toBe(false);
		expect(
			shouldAutoOpenPilotOnboarding({
				config: existingUserConfig,
				progress: dismissPilotOnboarding(EMPTY_PILOT_ONBOARDING_PROGRESS, 2),
				userCreatedAt,
			}),
		).toBe(false);
	});

	it('reopens after a configuration version increase', () => {
		const progress = completePilotOnboarding(EMPTY_PILOT_ONBOARDING_PROGRESS, 2);
		expect(
			shouldAutoOpenPilotOnboarding({
				config: {...CONFIG, version: 3, show_for_existing_users: true},
				progress,
				userCreatedAt: new Date('2020-01-01T00:00:00.000Z'),
			}),
		).toBe(true);
	});

	it('lists enabled steps and acknowledges each step once', () => {
		expect(getEnabledPilotOnboardingSteps(CONFIG)).toEqual(['profile', 'security', 'media', 'community']);
		const acknowledged = acknowledgePilotOnboardingStep(EMPTY_PILOT_ONBOARDING_PROGRESS, 'media');
		expect(acknowledged.acknowledgedStepIds).toEqual(['media']);
		expect(acknowledgePilotOnboardingStep(acknowledged, 'media')).toBe(acknowledged);
	});
});
