// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated synthetic browser acceptance fixture; never connects to a deployed API.

import '@app/features/auth/flow/MigrationClaimBootstrap';
import '@fluxer/fonts/css/fluxer-sans.css';
import '@fluxer/fonts/css/variables.css';
import '@app/features/theme/styles/preflight.css';
import '@app/features/theme/styles/generated/color-system.css';
import '@app/app/globals.css';
import layout from '@app/features/app/components/layout/AuthLayout.module.css';
import MigrationClaimPage from '@app/features/auth/components/pages/MigrationClaimPage';
import {AuthCardContainer} from '@app/features/auth/flow/AuthCardContainer';
import {AuthLayoutContext} from '@app/features/auth/state/AuthLayoutContext';
import {AppI18nProvider} from '@app/features/i18n/components/AppI18nProvider';
import {i18n} from '@lingui/core';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

i18n.load('en-US', {});
i18n.activate('en-US');
document.documentElement.classList.add('theme-dark');
const presentation = {
	setSplashUrl: () => {},
	setShowLogoSide: () => {},
	setCardVariant: () => {},
	setContentMode: () => {},
	setSplashCardAlignment: () => {},
};
createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<AppI18nProvider i18n={i18n}>
			<AuthLayoutContext.Provider value={presentation}>
				<main className={layout.container}>
					<div className={layout.leftSplit}>
						<AuthCardContainer variant="standard">
							<MigrationClaimPage />
						</AuthCardContainer>
					</div>
				</main>
			</AuthLayoutContext.Provider>
		</AppI18nProvider>
	</StrictMode>,
);
