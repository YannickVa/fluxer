// SPDX-License-Identifier: AGPL-3.0-or-later

export const MIGRATION_CLAIM_PATH = '/migration/claim';

export type MigrationClaimLink = {status: 'ready'; token: string} | {status: 'missing' | 'invalid' | 'unsafe_location'};

// The final base64url character has two zero padding bits for a 32-byte token.
export const isMigrationOwnershipToken = (value: string): boolean =>
	/^mc1\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);

interface ClaimBrowser {
	location: {pathname: string; search: string; hash: string};
	history: {replaceState(data: unknown, unused: string, url?: string | URL | null): void};
}

/** Call before router/history bootstrap. Never read a credential from a query string. */
export function captureMigrationClaimLink(browser: ClaimBrowser): MigrationClaimLink {
	if (browser.location.pathname !== MIGRATION_CLAIM_PATH) return {status: 'missing'};
	const search = browser.location.search;
	const hash = browser.location.hash;
	try {
		// Drop state as well: it must not become another credential persistence channel.
		browser.history.replaceState(null, '', MIGRATION_CLAIM_PATH);
	} catch {
		// Do not retain the token or propagate a native error that could echo the URL.
		return {status: 'unsafe_location'};
	}
	if (!hash && !search) return {status: 'missing'};
	if (search) return {status: 'invalid'};
	const params = new URLSearchParams(hash.slice(1));
	const entries = [...params.entries()];
	if (entries.length !== 1 || entries[0]![0] !== 'token') return {status: 'invalid'};
	const token = entries[0]![1];
	return isMigrationOwnershipToken(token) ? {status: 'ready', token} : {status: 'invalid'};
}
