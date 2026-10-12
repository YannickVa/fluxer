// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated synthetic browser acceptance fixture; never connects to a deployed API.

import {observable} from 'mobx';
import type {ReactNode} from 'react';

export default observable({
	apiEndpoint: `${location.origin}/api`,
	apiCodeVersion: 1,
	isAuthenticated: Boolean((window as Window & {__fixtureSignedIn?: boolean}).__fixtureSignedIn),
	isInitialized: true,
	initialize: async () => {},
	isSelfHosted: () => true,
	termsUrl: '/terms',
	privacyUrl: '/privacy',
	productName: 'Fluxer',
	logoUrl: null,
	wordmarkUrl: null,
	enabled: false,
	keyboardModeEnabled: true,
	scrollbarVisibility: 'always',
});
export const shouldDisableAutofocusOnMobile = () => innerWidth < 600;
export const Routes = {LOGIN: '/login', ME: '/channels/@me', terms: () => '/terms', privacy: () => '/privacy'};
export const useFluxerDocumentTitle = (title: string) => {
	document.title = title;
};
export const isMobileExperienceEnabled = () => innerWidth < 600;
export const getCurrentLocale = () => 'en-US';
export const Link = ({to, children, ...props}: {to: string; children: ReactNode}) => (
	<a href={to} {...props}>
		{children}
	</a>
);
export const ExternalLink = ({href, children, ...props}: {href: string; children: ReactNode}) => (
	<a href={href} {...props}>
		{children}
	</a>
);
