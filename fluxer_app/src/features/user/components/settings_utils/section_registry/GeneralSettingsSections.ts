// SPDX-License-Identifier: AGPL-3.0-or-later

import {msg} from '@lingui/core/macro';
import type {SectionDefinition} from './SectionRegistryTypes';

const PROFILE_CUSTOMIZATION_DESCRIPTOR = msg({
	message: 'Profile customization',
	comment: 'Settings section label for editing profile appearance and identity.',
});
const REDEEM_A_GIFT_DESCRIPTOR = msg({
	message: 'Redeem a gift',
	comment: 'Settings section label for redeeming a gift code.',
});
const PURCHASED_GIFTS_DESCRIPTOR = msg({
	message: 'Purchased gifts',
	comment: 'Settings section label for managing purchased gift codes.',
});
const EMOJI_PACKS_DESCRIPTOR = msg({
	message: 'Emoji packs',
	comment: 'Settings section label for emoji expression packs.',
});
const STICKER_PACKS_DESCRIPTOR = msg({
	message: 'Sticker packs',
	comment: 'Settings section label for sticker expression packs.',
});
const BLOCKED_USERS_DESCRIPTOR = msg({
	message: 'Blocked users',
	comment: 'Settings section label for blocked users.',
});
const AUTHORIZED_APPLICATIONS_DESCRIPTOR = msg({
	message: 'Authorized applications',
	comment: 'Settings search synonym. Used to match this term when the user types it in the settings search bar.',
});
const AUTHORIZED_APPS_DESCRIPTOR = msg({
	message: 'Authorized apps',
	comment: 'Settings section label for OAuth applications authorized by the user.',
});
const LINKED_CONNECTIONS_DESCRIPTOR = msg({
	message: 'Connections',
	comment: 'Settings section label for external accounts and verified domains.',
});
const SIGNED_IN_DEVICES_DESCRIPTOR = msg({
	message: 'Signed-in devices',
	comment: 'Settings section label for account sessions and devices.',
});
const TIME_FORMAT_DESCRIPTOR = msg({
	message: 'Time format',
	comment: 'Settings section label for app time display format.',
});
const INTERFACE_LANGUAGE_DESCRIPTOR = msg({
	message: 'Interface language',
	comment: 'Settings section label for interface language selection.',
});
const LANGUAGE_SETTINGS_DESCRIPTOR = msg({
	message: 'Language settings',
	comment: 'Settings search synonym. Used to match this term when the user types it in the settings search bar.',
});
const SPELLCHECK_DESCRIPTOR = msg({
	message: 'Spellcheck',
	comment: 'Settings section label for spellcheck settings.',
});
const DESKTOP_WINDOW_DESCRIPTOR = msg({
	message: 'Desktop window',
	comment: 'Settings section label for desktop window behavior.',
});
const DEVELOPER_MODE_DESCRIPTOR = msg({
	message: 'Developer mode',
	comment: 'Settings section label for client developer mode.',
});
const UNFURL_DEBUGGER_DESCRIPTOR = msg({
	message: 'Unfurl debugger',
	comment: 'Settings section label for the embed debugger URL input.',
});
const APPLICATIONS_LIST_DESCRIPTOR = msg({
	message: 'Applications',
	comment: 'Settings section label for developer application list.',
});
const SYSTEM_CHECK_DESCRIPTOR = msg({
	message: 'Check my setup',
	comment: 'Support Center section for live service, connection, device, and update checks.',
});
const COMMON_FIXES_DESCRIPTOR = msg({
	message: 'Fix a common problem',
	comment: 'Support Center section linking to common troubleshooting settings.',
});
const VERSION_UPDATES_DESCRIPTOR = msg({
	message: 'Version & updates',
	comment: 'Support Center section showing release identity and update controls.',
});
const SUPPORT_DIAGNOSTICS_DESCRIPTOR = msg({
	message: 'Diagnostics to share',
	comment: 'Support Center section for previewing and exporting privacy-safe diagnostics.',
});

export const generalSettingsSections = [
	{
		id: 'profile-customization',
		tabType: 'my_profile',
		label: PROFILE_CUSTOMIZATION_DESCRIPTOR,
		keywords: [],
		isAdvanced: false,
	},
	{id: 'redeem-gift', tabType: 'gift_inventory', label: REDEEM_A_GIFT_DESCRIPTOR, keywords: [], isAdvanced: false},
	{
		id: 'purchased-gifts',
		tabType: 'gift_inventory',
		label: PURCHASED_GIFTS_DESCRIPTOR,
		keywords: [],
		isAdvanced: false,
	},
	{id: 'emoji-packs', tabType: 'expression_packs', label: EMOJI_PACKS_DESCRIPTOR, keywords: [], isAdvanced: false},
	{id: 'sticker-packs', tabType: 'expression_packs', label: STICKER_PACKS_DESCRIPTOR, keywords: [], isAdvanced: false},
	{id: 'blocked-users', tabType: 'blocked_users', label: BLOCKED_USERS_DESCRIPTOR, keywords: [], isAdvanced: false},
	{
		id: 'authorized-applications',
		tabType: 'authorized_apps',
		label: AUTHORIZED_APPS_DESCRIPTOR,
		keywords: [AUTHORIZED_APPLICATIONS_DESCRIPTOR],
		isAdvanced: false,
	},
	{
		id: 'connections',
		tabType: 'linked_accounts',
		label: LINKED_CONNECTIONS_DESCRIPTOR,
		keywords: [],
		isAdvanced: false,
	},
	{id: 'signed-in-devices', tabType: 'devices', label: SIGNED_IN_DEVICES_DESCRIPTOR, keywords: [], isAdvanced: false},
	{
		id: 'language-settings',
		tabType: 'language',
		label: INTERFACE_LANGUAGE_DESCRIPTOR,
		keywords: [LANGUAGE_SETTINGS_DESCRIPTOR],
		isAdvanced: false,
	},
	{id: 'time-format', tabType: 'language', label: TIME_FORMAT_DESCRIPTOR, keywords: [], isAdvanced: false},
	{id: 'spellcheck', tabType: 'language', label: SPELLCHECK_DESCRIPTOR, keywords: [], isAdvanced: false},
	{
		id: 'desktop-window',
		tabType: 'desktop_settings',
		label: DESKTOP_WINDOW_DESCRIPTOR,
		keywords: [],
		isAdvanced: false,
	},
	{
		id: 'developer-mode',
		tabType: 'client_developer_settings',
		label: DEVELOPER_MODE_DESCRIPTOR,
		keywords: [],
		isAdvanced: false,
	},
	{
		id: 'unfurl-debugger',
		tabType: 'embed_debugger',
		label: UNFURL_DEBUGGER_DESCRIPTOR,
		keywords: [],
		isAdvanced: false,
	},
	{
		id: 'applications-list',
		tabType: 'applications',
		label: APPLICATIONS_LIST_DESCRIPTOR,
		keywords: [],
		isAdvanced: false,
	},
	{
		id: 'system-check',
		tabType: 'support_center',
		label: SYSTEM_CHECK_DESCRIPTOR,
		keywords: ['support', 'health', 'status', 'connection', 'gateway', 'voice', 'devices', 'permissions'],
		isAdvanced: false,
	},
	{
		id: 'common-fixes',
		tabType: 'support_center',
		label: COMMON_FIXES_DESCRIPTOR,
		keywords: ['help', 'troubleshoot', 'microphone', 'camera', 'notifications', 'display'],
		isAdvanced: false,
	},
	{
		id: 'version-updates',
		tabType: 'support_center',
		label: VERSION_UPDATES_DESCRIPTOR,
		keywords: ['build', 'release', 'desktop', 'browser', 'update', 'upgrade'],
		isAdvanced: false,
	},
	{
		id: 'diagnostics',
		tabType: 'support_center',
		label: SUPPORT_DIAGNOSTICS_DESCRIPTOR,
		keywords: ['logs', 'report', 'export', 'download', 'copy', 'privacy'],
		isAdvanced: false,
	},
] as const satisfies ReadonlyArray<SectionDefinition>;
