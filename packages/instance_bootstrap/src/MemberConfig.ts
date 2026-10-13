// SPDX-License-Identifier: AGPL-3.0-or-later

import type {InstanceOnboarding, InstanceSupport} from '@fluxer/instance_bootstrap/src/Types';
import {InstanceAppPublicSchema} from '@fluxer/schema/src/domains/instance/InstanceSchemas';

export const DEFAULT_INSTANCE_ONBOARDING: InstanceOnboarding = {
	enabled: false,
	version: 1,
	enabled_at: null,
	show_for_existing_users: false,
	welcome_message: null,
	operator_name: null,
	availability_message: null,
	primary_guild_id: null,
	rules_channel_id: null,
	introduction_channel_id: null,
	mfa_policy: 'recommended',
	steps: {profile: true, security: true, notifications: true, media: true, community: true},
};
export const DEFAULT_INSTANCE_SUPPORT: InstanceSupport = {
	status_url: null,
	support_user_id: null,
	service_updates_channel_id: null,
	feedback_channel_id: null,
};
const OnboardingPatch = InstanceAppPublicSchema.shape.onboarding.partial().extend({
	steps: InstanceAppPublicSchema.shape.onboarding.shape.steps.partial().optional(),
});

export function normalizeInstanceMemberConfig(value: {onboarding?: unknown; support?: unknown}): {
	onboarding: InstanceOnboarding;
	support: InstanceSupport;
} {
	const onboarding = OnboardingPatch.safeParse(value.onboarding ?? {});
	const support = InstanceAppPublicSchema.shape.support
		.partial()
		.refine((settings) => {
			if (!settings.status_url) return true;
			try {
				const url = new URL(settings.status_url);
				return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
			} catch {
				return false;
			}
		})
		.safeParse(value.support ?? {});
	// Discovery must remain usable when a newer server publishes an unknown setting.
	const onboardingData = onboarding.success ? onboarding.data : {};
	const supportData = support.success ? support.data : {};
	return {
		onboarding: {
			...DEFAULT_INSTANCE_ONBOARDING,
			...onboardingData,
			steps: {...DEFAULT_INSTANCE_ONBOARDING.steps, ...onboardingData.steps},
		},
		support: {...DEFAULT_INSTANCE_SUPPORT, ...supportData},
	};
}
