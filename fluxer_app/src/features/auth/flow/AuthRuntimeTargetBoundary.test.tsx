// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
	initial: vi.fn(),
	defaultInput: vi.fn(),
	resolve: vi.fn(),
	accounts: vi.fn(),
	known: vi.fn(),
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	isDesktop: () => true,
	getElectronAPI: () => ({desktopRuntimeConfig: {initialInput: mocks.initial, defaultInput: mocks.defaultInput}}),
}));
vi.mock('@app/features/app/state/InstanceSnapshotStore', () => ({
	default: {resolve: mocks.resolve},
	runtimeInstanceKey: (snapshot: {apiEndpoint: string}) => snapshot.apiEndpoint,
}));
vi.mock('@app/features/auth/state/Accounts', () => ({default: {getAllAccounts: mocks.accounts}}));
vi.mock('@app/features/auth/flow/instance_selector/InstanceDirectoryStorage', () => ({
	loadKnownInstances: mocks.known,
}));
vi.mock('@app/features/auth/flow/AuthShellLoadingState', () => ({AuthShellLoadingState: () => null}));
vi.mock('@app/features/auth/flow/AuthRouteLoadError', () => ({AuthRouteLoadError: () => <span>error</span>}));

const {AuthRuntimeTargetBoundary, warmAuthRuntimeTarget} = await import('./AuthRuntimeTargetBoundary');
const {useAuthRuntimeTarget} = await import('../state/AuthRuntimeTarget');
const defaultSnapshot = {apiEndpoint: 'https://matskos.example'};
let target: ReturnType<typeof useAuthRuntimeTarget> | null = null;
function Probe() {
	target = useAuthRuntimeTarget();
	return null;
}
afterEach(() => {
	vi.clearAllMocks();
	target = null;
});
async function renderBoundary() {
	Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
	const root = createRoot(document.createElement('div'));
	await act(async () =>
		root.render(
			<AuthRuntimeTargetBoundary>
				<Probe />
			</AuthRuntimeTargetBoundary>,
		),
	);
	await act(async () => root.unmount());
	Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
}
async function warm() {
	mocks.initial.mockResolvedValue(null);
	mocks.defaultInput.mockResolvedValue(defaultSnapshot.apiEndpoint);
	mocks.resolve.mockResolvedValue({snapshot: defaultSnapshot});
	await warmAuthRuntimeTarget(new AbortController().signal);
}

test('uses a migrated endpoint as an editable default on a fresh profile', async () => {
	mocks.accounts.mockReturnValue([]);
	mocks.known.mockResolvedValue([]);
	await warm();
	await renderBoundary();
	expect(target?.snapshot).toEqual(defaultSnapshot);
	expect(target?.initialSnapshot).toBeNull();
	target?.reset();
	expect(target?.snapshot).toBeNull();
});

test('does not reapply the migrated default after choosing an instance and restarting', async () => {
	mocks.accounts.mockReturnValue([]);
	mocks.known.mockResolvedValue([{instanceKey: 'https://chosen.example'}]);
	await warm();
	await renderBoundary();
	expect(mocks.defaultInput).not.toHaveBeenCalled();
	expect(mocks.resolve).not.toHaveBeenCalled();
	expect(target?.snapshot).toBeNull();
});

test('leaves remembered accounts to the canonical account selector', async () => {
	mocks.accounts.mockReturnValue([{storageKey: 'remembered-account'}]);
	await warm();
	await renderBoundary();
	expect(mocks.defaultInput).not.toHaveBeenCalled();
	expect(target?.initialSnapshot).toBeNull();
});

test('keeps an explicit launch override as the selected initial instance', async () => {
	mocks.initial.mockResolvedValue('https://explicit.example');
	mocks.resolve.mockResolvedValue({snapshot: {apiEndpoint: 'https://explicit.example'}});
	await warmAuthRuntimeTarget(new AbortController().signal);
	await renderBoundary();
	expect(target?.initialSnapshot?.apiEndpoint).toBe('https://explicit.example');
	expect(mocks.defaultInput).not.toHaveBeenCalled();
});

test('an unreachable default still allows the instance selector to open', async () => {
	mocks.accounts.mockReturnValue([]);
	mocks.known.mockResolvedValue([]);
	mocks.initial.mockResolvedValue(null);
	mocks.defaultInput.mockResolvedValue('https://unreachable.example');
	mocks.resolve.mockRejectedValue(new Error('unreachable'));
	await warmAuthRuntimeTarget(new AbortController().signal);
	await renderBoundary();
	expect(target?.snapshot).toBeNull();
});

test('a stalled default discovery times out and leaves the instance selector usable', async () => {
	mocks.accounts.mockReturnValue([]);
	mocks.known.mockResolvedValue([]);
	mocks.initial.mockResolvedValue(null);
	mocks.defaultInput.mockResolvedValue('https://stalled.example');
	mocks.resolve.mockImplementation(
		({signal}: {signal: AbortSignal}) =>
			new Promise((_, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {once: true});
			}),
	);
	expect(await warmAuthRuntimeTarget(new AbortController().signal)).toBeNull();
	await renderBoundary();
	expect(target?.snapshot).toBeNull();
});

test('an outer cancellation during default discovery remains a cancellation', async () => {
	mocks.accounts.mockReturnValue([]);
	mocks.known.mockResolvedValue([]);
	mocks.initial.mockResolvedValue(null);
	mocks.defaultInput.mockResolvedValue('https://cancelled.example');
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	mocks.resolve.mockImplementation(
		({signal}: {signal: AbortSignal}) =>
			new Promise((_, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {once: true});
				markStarted();
			}),
	);
	const controller = new AbortController();
	const cancelled = warmAuthRuntimeTarget(controller.signal);
	const rejection = expect(cancelled).rejects.toThrow('synthetic cancellation');
	await started;
	controller.abort(new Error('synthetic cancellation'));
	await rejection;
});
