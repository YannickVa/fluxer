// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise the actual notification handler; isolate platform/storage/account dependencies.

import {MessageFlags} from '@fluxer/constants/src/ChannelConstants';
import type {Message} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const sound = vi.fn();
let notifications: typeof import('./Notification')['default'];
let visibleChannel: string | null = '200';

beforeAll(async () => {
	for (const path of [
		'@app/app/Routes',
		'@app/features/app/state/RuntimeConfig',
		'@app/features/auth/state/AccountManager',
		'@app/features/guild/state/Guilds',
		'@app/features/messaging/utils/MessageUtils',
		'@app/features/notification/utils/MessageNotificationPreview',
		'@app/features/platform/push/PushSubscriptionService',
		'@app/features/relationship/state/FriendsTab',
		'@app/features/user/state/UserGuildSettings',
		'@app/features/user/state/Users',
		'@app/features/user/utils/AvatarUtils',
		'@app/features/user/utils/NicknameUtils',
	])
		vi.doMock(path, () => ({default: {}}));
	vi.doMock('@lingui/core/macro', () => ({msg: (value: unknown) => value}));
	vi.doMock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '700'}}));
	vi.doMock('@app/features/channel/state/Channels', () => ({
		default: {getChannel: () => ({id: '200', guildId: '901'})},
	}));
	vi.doMock('@app/features/guild/state/GuildMatureContentAgree', () => ({default: {shouldShowGate: () => false}}));
	vi.doMock('@app/features/messaging/models/MessagingMessage', () => ({Message: class {}}));
	vi.doMock('@app/features/navigation/state/Navigation', () => ({
		default: {
			get channelId() {
				return visibleChannel;
			},
		},
	}));
	vi.doMock('@app/features/navigation/state/SelectedChannel', () => ({default: {currentChannelId: null}}));
	vi.doMock('@app/features/platform/types/Env', () => ({IS_DEV: false}));
	vi.doMock('@app/features/platform/utils/AppLogger', () => ({
		Logger: class {
			error() {}
		},
	}));
	vi.doMock('@app/features/platform/utils/MobXPersistence', () => ({
		makePersistent: async () => {},
		stopPersistent: () => {},
	}));
	vi.doMock('@app/features/presence/state/LocalPresence', () => ({default: {getStatus: () => 'online'}}));
	vi.doMock('@app/features/relationship/state/Relationships', () => ({default: {isBlocked: () => false}}));
	vi.doMock('@app/features/relationship/utils/RelationshipMessageDescriptors', () => ({FRIEND_ADDED_DESCRIPTOR: {}}));
	vi.doMock('@app/features/streamer_mode/state/StreamerMode', () => ({default: {shouldDisableNotifications: false}}));
	vi.doMock('@app/features/ui/state/Modal', () => ({default: {hasModalOpen: () => false}}));
	vi.doMock('@app/features/ui/utils/PwaUtils', () => ({isInstalledPwa: () => false}));
	vi.doMock('@app/features/notification/utils/NotificationUtils', () => ({
		ensureDesktopNotificationClickHandler: () => {},
		isGranted: async () => false,
		playSameChannelNotificationSoundIfEnabled: sound,
	}));
	notifications = (await import('./Notification')).default;
});

beforeEach(() => {
	sound.mockClear();
	notifications.notifiedMessageIds.clear();
	notifications.focused = true;
	visibleChannel = '200';
});

const message = (flags: number): Message => ({id: '300', channel_id: '200', author: {id: '701'}, flags}) as Message;

describe('silent historical message notifications', () => {
	it('does not play focused-channel sounds or record a notification for silent history', () => {
		expect(notifications.handleMessageCreate({message: message(MessageFlags.SUPPRESS_NOTIFICATIONS)})).toBe(false);
		expect(sound).not.toHaveBeenCalled();
		expect(notifications.notifiedMessageIds.size).toBe(0);
	});
	it('retains the ordinary live-message focused-channel sound path', () => {
		expect(notifications.handleMessageCreate({message: message(0)})).toBe(true);
		expect(sound).toHaveBeenCalledOnce();
		expect(notifications.notifiedMessageIds.has('300')).toBe(true);
	});
	it('refuses silent history when the channel is not visible and other supported flags are set', () => {
		visibleChannel = null;
		expect(
			notifications.handleMessageCreate({
				message: message(MessageFlags.SUPPRESS_NOTIFICATIONS | MessageFlags.SUPPRESS_EMBEDS),
			}),
		).toBe(false);
		expect(sound).not.toHaveBeenCalled();
		expect(notifications.notifiedMessageIds.size).toBe(0);
	});
});
