// SPDX-License-Identifier: AGPL-3.0-or-later

import {InstanceConfigUpdateRequest} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import {describe, expect, it} from 'vitest';

describe('pilot instance configuration schemas', () => {
	it('accepts public rollout copy, destinations, and valid snowflake IDs', () => {
		const result = InstanceConfigUpdateRequest.safeParse({
			app_public: {
				onboarding: {
					enabled: true,
					version: 2,
					primary_guild_id: '123456789012345678',
					rules_channel_id: '223456789012345678',
					mfa_policy: 'recommended',
				},
				support: {
					status_url: 'https://status.example.test',
					support_user_id: '323456789012345678',
					service_updates_channel_id: '423456789012345678',
					feedback_channel_id: '523456789012345678',
				},
			},
		});

		expect(result.success).toBe(true);
	});

	it('rejects malformed channel IDs and non-URL support destinations', () => {
		expect(
			InstanceConfigUpdateRequest.safeParse({
				app_public: {onboarding: {primary_guild_id: 'not-a-snowflake'}},
			}).success,
		).toBe(false);
		expect(
			InstanceConfigUpdateRequest.safeParse({
				app_public: {support: {status_url: 'ftp://example.test/status'}},
			}).success,
		).toBe(false);
	});
});
