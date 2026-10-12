// SPDX-License-Identifier: AGPL-3.0-or-later

import {captureMigrationClaimLink, type MigrationClaimLink} from './MigrationClaimLink';

// This module is the first startup import: no stores, logger, router, or persistence.
let pending: MigrationClaimLink =
	typeof window === 'undefined' ? {status: 'missing'} : captureMigrationClaimLink(window);

if (pending.status === 'unsafe_location') {
	// Do not let the normal router, history or diagnostics see an uncleared credential URL.
	// Localization cannot bootstrap safely here; this emergency notice has no private values.
	const root = document.getElementById('root');
	if (root) {
		root.textContent =
			'This claim link could not be opened safely. Close this page and ask your administrator for help.';
		root.setAttribute('role', 'alert');
		root.style.color = 'CanvasText';
		root.style.backgroundColor = 'Canvas';
		root.style.padding = '1rem';
	}
	throw new Error('Migration claim URL cleanup failed.');
}

export function takeMigrationClaimLink(): MigrationClaimLink {
	const link = pending;
	pending = {status: 'missing'};
	return link;
}

if (typeof window !== 'undefined') {
	window.addEventListener('pagehide', () => {
		pending = {status: 'missing'};
	});
}
