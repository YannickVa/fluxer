// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BuildChannel} from '@electron/common/BuildChannel';
import type {DesktopBuildVariant} from '@electron/common/Types';

type DesktopUpdateEndpointOptions = {
	channel: BuildChannel;
	platform: NodeJS.Platform;
	arch: 'x64' | 'arm64';
	variant: DesktopBuildVariant;
	updateBaseUrlOverride?: string;
	downloadPageUrlOverride?: string;
};

function normalizeHttpsOverride(value: string | undefined, name: string): string | null {
	const normalized = value?.trim().replace(/\/+$/, '');
	if (!normalized) return null;
	const parsed = new URL(normalized);
	if (parsed.protocol !== 'https:') {
		throw new Error(`${name} must use HTTPS.`);
	}
	return normalized;
}

export function resolveDesktopUpdateEndpoints(options: DesktopUpdateEndpointOptions): {
	updateBaseUrl: string;
	downloadPageUrl: string;
} {
	const apiEndpoint = options.channel === 'canary' ? 'https://api.canary.fluxer.app' : 'https://api.fluxer.app';
	const variantSegment = options.platform === 'win32' && options.variant !== 'default' ? `/${options.variant}` : '';
	const defaultUpdateBaseUrl = `${apiEndpoint}/dl/desktop/${options.channel}/${options.platform}/${options.arch}${variantSegment}`;
	const defaultDownloadPageUrl =
		options.channel === 'canary' ? 'https://canary.fluxer.app/download' : 'https://fluxer.app/download';

	return {
		updateBaseUrl:
			normalizeHttpsOverride(options.updateBaseUrlOverride, 'PUBLIC_DESKTOP_UPDATE_BASE_URL') ?? defaultUpdateBaseUrl,
		downloadPageUrl:
			normalizeHttpsOverride(options.downloadPageUrlOverride, 'PUBLIC_DESKTOP_DOWNLOAD_URL') ?? defaultDownloadPageUrl,
	};
}
