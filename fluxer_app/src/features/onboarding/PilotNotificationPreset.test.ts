// SPDX-License-Identifier: AGPL-3.0-or-later

import {MessageNotifications} from '@fluxer/constants/src/NotificationConstants';
import {describe, expect, it} from 'vitest';
import {getPilotNotificationPresetLevels, resolvePilotNotificationPreset} from './PilotNotificationPreset';

describe('PilotNotificationPreset', () => {
	it.each([
		['everything', MessageNotifications.ALL_MESSAGES, MessageNotifications.ALL_MESSAGES],
		['mentions_dms', MessageNotifications.ONLY_MENTIONS, MessageNotifications.ALL_MESSAGES],
		['quiet', MessageNotifications.NO_MESSAGES, MessageNotifications.NO_MESSAGES],
	] as const)('maps and recognizes the %s preset', (preset, community, directMessages) => {
		const levels = getPilotNotificationPresetLevels(preset);
		expect(levels).toEqual({community, directMessages});
		expect(resolvePilotNotificationPreset(levels)).toBe(preset);
	});

	it('does not label a customized combination as a preset', () => {
		expect(
			resolvePilotNotificationPreset({
				community: MessageNotifications.ONLY_MENTIONS,
				directMessages: MessageNotifications.NO_MESSAGES,
			}),
		).toBeNull();
	});
});
