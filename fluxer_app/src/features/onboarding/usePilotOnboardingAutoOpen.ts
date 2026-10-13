// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {getPilotOnboardingProgress} from '@app/features/onboarding/PilotOnboardingPreferences';
import {shouldAutoOpenPilotOnboarding} from '@app/features/onboarding/PilotOnboardingState';
import UserSettings from '@app/features/user/state/UserSettings';
import {useEffect} from 'react';

const openedThisSession = new Set<string>();

export function usePilotOnboardingAutoOpen({
	isReady,
	user,
	hasModalOpen,
	onOpen,
}: {
	isReady: boolean;
	user: {id: string; createdAt: Date; isClaimed(): boolean} | null | undefined;
	hasModalOpen: boolean;
	onOpen: () => void;
}): void {
	const hydrated = UserSettings.isHydrated();
	const config = RuntimeConfig.onboarding;
	const instanceKey = RuntimeConfig.apiEndpoint;
	const progress = getPilotOnboardingProgress();
	const claimed = user?.isClaimed() ?? false;
	useEffect(() => {
		if (!isReady || !user || !claimed || !hydrated || hasModalOpen) return;
		const sessionKey = `${instanceKey}:${user.id}:${config.version}`;
		if (openedThisSession.has(sessionKey)) return;
		if (!shouldAutoOpenPilotOnboarding({config, progress, userCreatedAt: user.createdAt})) return;
		openedThisSession.add(sessionKey);
		onOpen();
	}, [isReady, user, claimed, hydrated, hasModalOpen, config, instanceKey, progress, onOpen]);
}
