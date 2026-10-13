// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {afterEach, expect, it, vi} from 'vitest';
import {MIGRATION_CLAIM_PATH} from './MigrationClaimLink';

afterEach(() => {
	vi.restoreAllMocks();
	window.history.replaceState(null, '', '/');
});

it('scrubs at module startup and hands the credential off only once', async () => {
	vi.resetModules();
	const token = `mc1.${'A'.repeat(43)}`;
	window.history.replaceState({credential: token}, '', `${MIGRATION_CLAIM_PATH}#token=${token}`);
	const bootstrap = await import('./MigrationClaimBootstrap');
	expect(window.location.hash).toBe('');
	expect(window.history.state).toBeNull();
	expect(bootstrap.takeMigrationClaimLink()).toEqual({status: 'ready', token});
	expect(bootstrap.takeMigrationClaimLink()).toEqual({status: 'missing'});
});

it('discards a pending credential on pagehide before the lazy page is loaded', async () => {
	vi.resetModules();
	window.history.replaceState(null, '', `${MIGRATION_CLAIM_PATH}#token=mc1.${'A'.repeat(43)}`);
	const bootstrap = await import('./MigrationClaimBootstrap');
	window.dispatchEvent(new Event('pagehide'));
	expect(bootstrap.takeMigrationClaimLink()).toEqual({status: 'missing'});
});

it('aborts application module startup if URL scrubbing fails, with only a constant emergency notice', async () => {
	vi.resetModules();
	const token = `mc1.${'A'.repeat(43)}`;
	window.history.replaceState(null, '', `${MIGRATION_CLAIM_PATH}#token=${token}`);
	vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
		throw new Error(`PRIVATE ${token}`);
	});
	const root = document.createElement('div');
	root.id = 'root';
	document.body.append(root);
	try {
		await expect(import('./MigrationClaimBootstrap')).rejects.toThrow('Migration claim URL cleanup failed.');
		expect(root.getAttribute('role')).toBe('alert');
		expect(root.textContent).toContain('Close this page');
		expect(root.textContent).not.toContain(token);
		expect(root.textContent).not.toContain('PRIVATE');
	} finally {
		root.remove();
	}
});
