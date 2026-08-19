// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const electronApi = vi.fn<() => Record<string, unknown> | null>();
const nativeMacOS = vi.fn<() => boolean>();
const nativeWindows = vi.fn<() => boolean>();

vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	getElectronAPI: () => electronApi(),
	isNativeMacOS: () => nativeMacOS(),
	isNativeWindows: () => nativeWindows(),
}));

const {checkNativePermission, openNativePermissionSettings, requestNativePermission} = await import(
	'./NativePermissions'
);

describe('NativePermissions', () => {
	beforeEach(() => {
		nativeMacOS.mockReturnValue(false);
		nativeWindows.mockReturnValue(false);
		electronApi.mockReset();
	});

	it('leaves non-macOS media permission decisions to Chromium', async () => {
		electronApi.mockReturnValue({});

		await expect(checkNativePermission('camera')).resolves.toBe('unsupported');
		await expect(requestNativePermission('camera')).resolves.toBe('unsupported');
		await expect(checkNativePermission('microphone')).resolves.toBe('unsupported');
	});

	it('opens Windows camera and microphone privacy settings', async () => {
		const openMediaAccessSettings = vi.fn(async () => undefined);
		nativeWindows.mockReturnValue(true);
		electronApi.mockReturnValue({openMediaAccessSettings});

		await openNativePermissionSettings('camera');
		await openNativePermissionSettings('microphone');
		await openNativePermissionSettings('screen');

		expect(openMediaAccessSettings).toHaveBeenNthCalledWith(1, 'camera');
		expect(openMediaAccessSettings).toHaveBeenNthCalledWith(2, 'microphone');
		expect(openMediaAccessSettings).toHaveBeenCalledTimes(2);
	});

	it('keeps using the macOS native media permission APIs', async () => {
		const checkMediaAccess = vi.fn(async () => 'not-determined');
		const requestMediaAccess = vi.fn(async () => true);
		nativeMacOS.mockReturnValue(true);
		electronApi.mockReturnValue({checkMediaAccess, requestMediaAccess});

		await expect(checkNativePermission('camera')).resolves.toBe('not-determined');
		await expect(requestNativePermission('camera')).resolves.toBe('granted');
		expect(checkMediaAccess).toHaveBeenCalledWith('camera');
		expect(requestMediaAccess).toHaveBeenCalledWith('camera');
	});
});
