// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CacheLogger} from '@pkgs/cache/src/CacheProviderTypes';

export function safeJsonParse<T>(value: string, logger?: CacheLogger): T | null {
	try {
		return JSON.parse(value);
	} catch {
		if (logger) {
			// Auth/session cache entries can contain credentials. Native JSON errors may
			// include the offending text too, so omit both payload and parser message.
			logger.error({valueLength: value.length}, '[CacheProvider] Invalid JSON entry; contents omitted');
		}
		return null;
	}
}

export function serializeValue<T>(value: T): string {
	return JSON.stringify(value);
}
