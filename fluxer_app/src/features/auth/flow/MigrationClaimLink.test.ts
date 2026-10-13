// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {afterEach, describe, expect, it, vi} from 'vitest';
import {captureMigrationClaimLink, MIGRATION_CLAIM_PATH} from './MigrationClaimLink';

const TOKEN = `mc1.${'A'.repeat(43)}`;

afterEach(() => {
	vi.restoreAllMocks();
	window.history.replaceState(null, '', '/');
});

describe('Private migration link capture', () => {
	it('takes only the fragment credential and removes URL/state before returning it', () => {
		window.history.replaceState({private: TOKEN}, '', `${MIGRATION_CLAIM_PATH}#token=${TOKEN}`);
		expect(captureMigrationClaimLink(window)).toEqual({status: 'ready', token: TOKEN});
		expect(window.location.pathname).toBe(MIGRATION_CLAIM_PATH);
		expect(window.location.search + window.location.hash).toBe('');
		expect(window.history.state).toBeNull();
		expect(captureMigrationClaimLink(window)).toEqual({status: 'missing'});
	});

	it.each([
		`?token=${TOKEN}`,
		`?redirect_to=/login#token=${TOKEN}`,
		`#token=${TOKEN}&token=${TOKEN}`,
		`#token=${TOKEN}&other=PRIVATE`,
		`#other=${TOKEN}`,
		`#token=mp1.${'A'.repeat(43)}`,
		`#token=mc1.${'A'.repeat(42)}B`,
		'#token=PRIVATE',
	])('refuses and scrubs malformed/query/ambiguous input %s', (suffix) => {
		window.history.replaceState(null, '', `${MIGRATION_CLAIM_PATH}${suffix}`);
		expect(captureMigrationClaimLink(window)).toEqual({status: 'invalid'});
		expect(window.location.search + window.location.hash).toBe('');
	});

	it('does not touch unrelated auth fragments or history', () => {
		window.history.replaceState({reset: true}, '', `/reset#token=${TOKEN}`);
		expect(captureMigrationClaimLink(window)).toEqual({status: 'missing'});
		expect(window.location.hash).toBe(`#token=${TOKEN}`);
		expect(window.history.state).toEqual({reset: true});
	});

	it('refuses safely when history cleanup fails, without echoing the native URL error', () => {
		window.history.replaceState(null, '', `${MIGRATION_CLAIM_PATH}#token=${TOKEN}`);
		vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
			throw new Error(`PRIVATE ${TOKEN}`);
		});
		expect(captureMigrationClaimLink(window)).toEqual({status: 'unsafe_location'});
	});
});
