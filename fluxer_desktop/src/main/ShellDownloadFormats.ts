// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUILD_CHANNEL, type BuildChannel} from '@electron/common/BuildChannel';
import {normalizeHttpsOverride} from '@electron/main/DesktopUpdateEndpoints';

export type DesktopDownloadArch = 'x64' | 'arm64';

export function getDesktopDownloadArch(arch: NodeJS.Architecture): DesktopDownloadArch {
	return arch === 'arm64' ? 'arm64' : 'x64';
}

export const DESKTOP_DOWNLOAD_ARCH = getDesktopDownloadArch(process.arch);
const PACKAGE_ORIGIN_ENV = 'FLUXER_DESKTOP_PACKAGE_ORIGIN';
const CHANNEL_PACKAGE_ORIGINS: Record<BuildChannel, string> = {
	stable: 'https://pkgs.fluxer.com',
	canary: 'https://pkgs.fluxer.com',
	development: 'http://localhost:48780',
};

export function resolveDesktopPackageOrigin(): string {
	const override = process.env?.[PACKAGE_ORIGIN_ENV] || process.env.PUBLIC_DESKTOP_PACKAGE_ORIGIN;
	if (override == null || override.trim().length === 0) {
		if (process.env.PUBLIC_DESKTOP_UPDATE_BASE_URL) {
			if (process.env.FLUXER_MODULES === '1')
				throw new Error('Fork module updates require PUBLIC_DESKTOP_PACKAGE_ORIGIN.');
			return new URL(
				normalizeHttpsOverride(process.env.PUBLIC_DESKTOP_UPDATE_BASE_URL, 'PUBLIC_DESKTOP_UPDATE_BASE_URL')!,
			).origin;
		}
		return CHANNEL_PACKAGE_ORIGINS[BUILD_CHANNEL];
	}
	const url = new URL(override.trim());
	const localDevelopment =
		Boolean(process.env?.[PACKAGE_ORIGIN_ENV]) &&
		url.protocol === 'http:' &&
		['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (
		(!localDevelopment && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	)
		throw new Error('Desktop package origin must be an HTTPS origin.');
	return url.origin;
}

export function getUpdateBaseUrl(platform: NodeJS.Platform = process.platform): string {
	const override = normalizeHttpsOverride(process.env.PUBLIC_DESKTOP_UPDATE_BASE_URL, 'PUBLIC_DESKTOP_UPDATE_BASE_URL');
	if (override) return override;
	return `${resolveDesktopPackageOrigin()}/desktop/${BUILD_CHANNEL}/${platform}/${DESKTOP_DOWNLOAD_ARCH}`;
}

export const MANUAL_DESKTOP_FORMATS = ['setup', 'dmg', 'zip', 'appimage', 'deb', 'rpm', 'tar_gz'] as const;

export type ManualDesktopFormat = (typeof MANUAL_DESKTOP_FORMATS)[number];
export type LinuxManualDesktopFormat = Extract<ManualDesktopFormat, 'appimage' | 'deb' | 'rpm' | 'tar_gz'>;

export const LINUX_MANUAL_FORMAT_EXTENSIONS: Record<LinuxManualDesktopFormat, string> = {
	appimage: '.AppImage',
	deb: '.deb',
	rpm: '.rpm',
	tar_gz: '.tar.gz',
};

export const LINUX_MANUAL_ARCH_TOKENS: Record<LinuxManualDesktopFormat, Record<DesktopDownloadArch, string>> = {
	appimage: {x64: 'x86_64', arm64: 'arm64'},
	deb: {x64: 'amd64', arm64: 'arm64'},
	rpm: {x64: 'x86_64', arm64: 'aarch64'},
	tar_gz: {x64: 'x64', arm64: 'arm64'},
};

export const SPLASH_LINUX_FORMAT_ORDER: ReadonlyArray<LinuxManualDesktopFormat> = ['deb', 'rpm', 'appimage', 'tar_gz'];

export const SPLASH_LINUX_FORMAT_LABELS: Record<LinuxManualDesktopFormat, string> = {
	deb: 'Debian (deb)',
	rpm: 'Fedora (rpm)',
	appimage: 'Linux (AppImage)',
	tar_gz: 'Linux (tar.gz)',
};

export function isLinuxManualDesktopFormat(format: ManualDesktopFormat): format is LinuxManualDesktopFormat {
	return format === 'appimage' || format === 'deb' || format === 'rpm' || format === 'tar_gz';
}

export function buildManualLatestDownloadUrl(format: ManualDesktopFormat): string {
	const override = normalizeHttpsOverride(process.env.PUBLIC_DESKTOP_DOWNLOAD_URL, 'PUBLIC_DESKTOP_DOWNLOAD_URL');
	if (override) return override;
	return `${getUpdateBaseUrl()}/latest/${format}`;
}
