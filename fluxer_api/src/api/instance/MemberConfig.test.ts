// SPDX-License-Identifier: AGPL-3.0-or-later

import {normalizeInstanceMemberConfig} from '@fluxer/instance_bootstrap/src/MemberConfig';
import {describe, expect, it} from 'vitest';

describe('instance member configuration compatibility', () => {
	it('defaults older discovery documents to disabled onboarding', () => {
		const result = normalizeInstanceMemberConfig({});
		expect(result.onboarding.enabled).toBe(false);
		expect(Object.values(result.support).every((value) => value === null)).toBe(true);
	});
	it('preserves every step combination across normalization without changing its input', () => {
		const keys = ['profile', 'security', 'notifications', 'media', 'community'] as const;
		for (let mask = 0; mask < 32; mask++) {
			const steps = Object.fromEntries(keys.map((key, index) => [key, (mask & (1 << index)) !== 0]));
			const input = {
				onboarding: {steps, welcome_message: 'Welcome'},
				support: {status_url: 'https://status.example.invalid'},
			};
			const before = JSON.stringify(input);
			const normalized = normalizeInstanceMemberConfig(input);
			expect(normalized.onboarding.steps).toEqual(steps);
			expect(normalizeInstanceMemberConfig(normalized)).toEqual(normalized);
			expect(JSON.stringify(input)).toBe(before);
		}
	});
	it('disables malformed or newer onboarding without losing valid support settings', () => {
		for (const onboarding of [
			{version: -1},
			{version: 0},
			{version: 1.5},
			{version: '1'},
			{primary_guild_id: 'invalid'},
			{mfa_policy: 'future-policy'},
		]) {
			const normalized = normalizeInstanceMemberConfig({
				onboarding,
				support: {status_url: 'https://status.example.invalid'},
			});
			expect(normalized.onboarding.enabled).toBe(false);
			expect(normalized.onboarding.version).toBe(1);
			expect(normalized.support.status_url).toBe('https://status.example.invalid');
		}
		expect(normalizeInstanceMemberConfig({support: {status_url: 'javascript:invalid'}}).support.status_url).toBeNull();
	});
});
