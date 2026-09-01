// SPDX-License-Identifier: AGPL-3.0-or-later

import {MessageNotifications} from '@fluxer/constants/src/NotificationConstants';

export type PilotNotificationPreset = 'everything' | 'mentions_dms' | 'quiet';

export interface PilotNotificationPresetLevels {
	community: number;
	directMessages: number;
}

export function getPilotNotificationPresetLevels(preset: PilotNotificationPreset): PilotNotificationPresetLevels {
	switch (preset) {
		case 'everything':
			return {
				community: MessageNotifications.ALL_MESSAGES,
				directMessages: MessageNotifications.ALL_MESSAGES,
			};
		case 'mentions_dms':
			return {
				community: MessageNotifications.ONLY_MENTIONS,
				directMessages: MessageNotifications.ALL_MESSAGES,
			};
		case 'quiet':
			return {
				community: MessageNotifications.NO_MESSAGES,
				directMessages: MessageNotifications.NO_MESSAGES,
			};
	}
}

export function resolvePilotNotificationPreset(levels: PilotNotificationPresetLevels): PilotNotificationPreset | null {
	if (
		levels.community === MessageNotifications.ALL_MESSAGES &&
		levels.directMessages === MessageNotifications.ALL_MESSAGES
	) {
		return 'everything';
	}
	if (
		levels.community === MessageNotifications.ONLY_MENTIONS &&
		levels.directMessages === MessageNotifications.ALL_MESSAGES
	) {
		return 'mentions_dms';
	}
	if (
		levels.community === MessageNotifications.NO_MESSAGES &&
		levels.directMessages === MessageNotifications.NO_MESSAGES
	) {
		return 'quiet';
	}
	return null;
}
