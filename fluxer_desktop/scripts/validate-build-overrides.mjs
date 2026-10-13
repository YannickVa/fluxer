// SPDX-License-Identifier: AGPL-3.0-or-later

import {pathToFileURL} from 'node:url';

export function validateDesktopBuildOverrides(environment, {requireForkSettings = false} = {}) {
	const values = {};
	for (const key of [
		'PUBLIC_DESKTOP_INSTANCE_ENDPOINT',
		'PUBLIC_DESKTOP_PACKAGE_ORIGIN',
		'PUBLIC_DESKTOP_UPDATE_BASE_URL',
		'PUBLIC_DESKTOP_DOWNLOAD_URL',
	]) {
		const raw = environment[key]?.trim();
		if (!raw) continue;
		const url = new URL(raw);
		const allowedProtocol = key === 'PUBLIC_DESKTOP_INSTANCE_ENDPOINT' ? ['https:', 'http:'] : ['https:'];
		if (!allowedProtocol.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
			throw new Error(
				`${key} must be a URL without credentials, query or fragment using ${allowedProtocol.join(' or ')}`,
			);
		}
		if (key === 'PUBLIC_DESKTOP_PACKAGE_ORIGIN' && url.pathname !== '/') {
			throw new Error(`${key} must be an origin without a path`);
		}
		values[key] = url;
	}
	const modulesEnabled = ['1', 'true'].includes(environment.FLUXER_MODULES);
	if (modulesEnabled && values.PUBLIC_DESKTOP_UPDATE_BASE_URL && !values.PUBLIC_DESKTOP_PACKAGE_ORIGIN) {
		throw new Error('Fork module builds require PUBLIC_DESKTOP_PACKAGE_ORIGIN');
	}
	if (requireForkSettings) {
		for (const key of ['PUBLIC_DESKTOP_INSTANCE_ENDPOINT', 'PUBLIC_DESKTOP_DOWNLOAD_URL']) {
			if (!values[key]) throw new Error(`Fork builds require ${key}`);
		}
		if (!values.PUBLIC_DESKTOP_PACKAGE_ORIGIN && !values.PUBLIC_DESKTOP_UPDATE_BASE_URL) {
			throw new Error('Fork builds require a controlled shell update feed or package origin');
		}
		if (modulesEnabled && !values.PUBLIC_DESKTOP_PACKAGE_ORIGIN) {
			throw new Error('Fork module builds require PUBLIC_DESKTOP_PACKAGE_ORIGIN');
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	validateDesktopBuildOverrides(process.env, {
		requireForkSettings: process.env.GITHUB_REPOSITORY_OWNER !== 'fluxerapp',
	});
}
