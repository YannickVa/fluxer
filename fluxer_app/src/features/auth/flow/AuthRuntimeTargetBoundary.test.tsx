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
vi.mock('@app/features/auth/flow/AuthRouteLoadError', () => ({
	AuthRouteLoadError: () => (
		<span data-flx="auth.flow.auth-runtime-target-boundary-test.auth-route-load-error.span">error</span>
	),
}));

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
async function renderBoundary(waitMs = 0) {
	Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
	const root = createRoot(document.createElement('div'));
	await act(async () =>
		root.render(
			<AuthRuntimeTargetBoundary data-flx="auth.flow.auth-runtime-target-boundary-test.render-boundary.auth-runtime-target-boundary">
				<Probe data-flx="auth.flow.auth-runtime-target-boundary-test.render-boundary.probe" />
			</AuthRuntimeTargetBoundary>,
		),
	);
	if (waitMs > 0) await act(async () => new Promise((resolve) => setTimeout(resolve, waitMs)));
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
	expect(mocks.resolve).not.toHaveBeenCalled();
	await renderBoundary();
	expect(mocks.resolve).toHaveBeenCalledTimes(1);
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
	expect(mocks.resolve).not.toHaveBeenCalled();
	await renderBoundary(3200);
	expect(mocks.resolve).toHaveBeenCalledTimes(1);
	expect(target).not.toBeNull();
	expect(target?.snapshot).toBeNull();
});

test('unmounting cancels pending optional discovery with the outer cancellation reason', async () => {
	mocks.accounts.mockReturnValue([]);
	mocks.known.mockResolvedValue([]);
	mocks.initial.mockResolvedValue(null);
	mocks.defaultInput.mockResolvedValue('https://cancelled.example');
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	let discoverySignal: AbortSignal | undefined;
	mocks.resolve.mockImplementation(
		({signal}: {signal: AbortSignal}) =>
			new Promise((_, reject) => {
				discoverySignal = signal;
				signal.addEventListener('abort', () => reject(signal.reason), {once: true});
				markStarted();
			}),
	);
	await warmAuthRuntimeTarget(new AbortController().signal);
	Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
	const container = document.createElement('div');
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<AuthRuntimeTargetBoundary data-flx="auth.flow.auth-runtime-target-boundary-test.auth-runtime-target-boundary">
				<Probe data-flx="auth.flow.auth-runtime-target-boundary-test.probe" />
			</AuthRuntimeTargetBoundary>,
		),
	);
	await started;
	await act(async () => root.unmount());
	expect(discoverySignal?.aborted).toBe(true);
	expect(discoverySignal?.reason.name).toBe('AbortError');
	Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

test('unavailable remembered-instance storage skips the default and leaves manual selection usable', async () => {
	mocks.accounts.mockReturnValue([]);
	mocks.known.mockRejectedValue(new Error('storage unavailable'));
	await warm();
	await renderBoundary();
	expect(target).not.toBeNull();
	expect(target?.snapshot).toBeNull();
	expect(mocks.defaultInput).not.toHaveBeenCalled();
	expect(mocks.resolve).not.toHaveBeenCalled();
});

test('an unavailable optional desktop default leaves manual selection usable', async () => {
	mocks.accounts.mockReturnValue([]);
	mocks.known.mockResolvedValue([]);
	await warm();
	mocks.defaultInput.mockRejectedValue(new Error('default IPC unavailable'));
	await renderBoundary();
	expect(target).not.toBeNull();
	expect(target?.snapshot).toBeNull();
	expect(mocks.resolve).not.toHaveBeenCalled();
});

test.each(['known', 'defaultInput', 'resolve'] as const)(
	'a stalled %s read shares the optional discovery deadline',
	async (step) => {
		mocks.accounts.mockReturnValue([]);
		mocks.known.mockResolvedValue([]);
		await warm();
		mocks[step].mockImplementation(() => new Promise(() => {}));
		await renderBoundary(3200);
		expect(target).not.toBeNull();
		expect(target?.snapshot).toBeNull();
		expect(mocks[step]).toHaveBeenCalledTimes(1);
		if (step !== 'resolve') expect(mocks.resolve).not.toHaveBeenCalled();
	},
);
