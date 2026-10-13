// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, test, vi} from 'vitest';

const mock = vi.hoisted(() => ({
	hydrated: false,
	version: 1,
	enabled: false,
	endpoint: 'https://first.example',
	completed: 0,
}));
const state = observable(mock);
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		get onboarding() {
			return {enabled: state.enabled, version: state.version, show_for_existing_users: true};
		},
		get apiEndpoint() {
			return state.endpoint;
		},
	},
}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {isHydrated: () => state.hydrated}}));
vi.mock('@app/features/onboarding/PilotOnboardingPreferences', () => ({
	getPilotOnboardingProgress: () => ({completedVersion: state.completed, dismissedVersion: 0, acknowledgedStepIds: []}),
}));
const {usePilotOnboardingAutoOpen} = await import('./usePilotOnboardingAutoOpen');

test('opens after late settings/config hydration and scopes the session to its instance', async () => {
	Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
	const onOpen = vi.fn();
	const user = {id: 'same-account-id', createdAt: new Date(), isClaimed: () => true};
	const Probe = observer(() => {
		usePilotOnboardingAutoOpen({isReady: true, user, hasModalOpen: false, onOpen});
		return null;
	});
	const container = document.createElement('div');
	const root = createRoot(container);
	try {
		await act(async () => root.render(<Probe />));
		expect(onOpen).not.toHaveBeenCalled();
		await act(async () =>
			runInAction(() => {
				state.hydrated = true;
			}),
		);
		expect(onOpen).not.toHaveBeenCalled();
		await act(async () =>
			runInAction(() => {
				state.enabled = true;
			}),
		);
		expect(onOpen).toHaveBeenCalledTimes(1);
		await act(async () =>
			runInAction(() => {
				state.completed = 1;
			}),
		);
		await act(async () =>
			runInAction(() => {
				state.completed = 0;
			}),
		);
		expect(onOpen).toHaveBeenCalledTimes(1);
		await act(async () =>
			runInAction(() => {
				state.endpoint = 'https://second.example';
			}),
		);
		expect(onOpen).toHaveBeenCalledTimes(2);
	} finally {
		await act(async () => root.unmount());
		Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
	}
});
