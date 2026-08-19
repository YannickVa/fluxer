// SPDX-License-Identifier: AGPL-3.0-or-later

import type {MediaAccessType} from '@electron/common/Types';

const MACOS_PRIVACY_KEYS: Record<MediaAccessType, string> = {
	microphone: 'Privacy_Microphone',
	camera: 'Privacy_Camera',
	screen: 'Privacy_ScreenCapture',
	'audio-capture': 'Privacy_AudioCapture',
};

const WINDOWS_PRIVACY_URIS: Partial<Record<MediaAccessType, string>> = {
	microphone: 'ms-settings:privacy-microphone',
	camera: 'ms-settings:privacy-webcam',
};

export function getMediaAccessSettingsUrl(
	type: MediaAccessType,
	platform: NodeJS.Platform = process.platform,
): string | null {
	if (platform === 'win32') {
		return WINDOWS_PRIVACY_URIS[type] ?? null;
	}
	if (platform === 'darwin') {
		return `x-apple.systempreferences:com.apple.preference.security?${MACOS_PRIVACY_KEYS[type]}`;
	}
	return null;
}
