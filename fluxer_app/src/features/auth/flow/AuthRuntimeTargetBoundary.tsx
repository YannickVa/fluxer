// SPDX-License-Identifier: AGPL-3.0-or-later

import InstanceSnapshotStore, {type RuntimeConfigSnapshot} from '@app/features/app/state/InstanceSnapshotStore';
import {loadKnownInstances} from '@app/features/auth/flow/instance_selector/InstanceDirectoryStorage';
import Accounts from '@app/features/auth/state/Accounts';
import {AuthRouteLoadError} from '@app/features/auth/flow/AuthRouteLoadError';
import {AuthShellLoadingState} from '@app/features/auth/flow/AuthShellLoadingState';
import {AuthRuntimeTarget, AuthRuntimeTargetProvider} from '@app/features/auth/state/AuthRuntimeTarget';
import {getElectronAPI, isDesktop} from '@app/features/ui/utils/NativeUtils';
import {type ReactNode, useCallback, useEffect, useReducer, useState} from 'react';

const AuthRuntimeResolutionStatus = Object.freeze({
	LOADING: 'loading',
	READY: 'ready',
	FAILED: 'failed',
} as const);

type AuthRuntimeResolutionState<Runtime> =
	| {
			readonly status: typeof AuthRuntimeResolutionStatus.LOADING;
			readonly attempt: number;
	  }
	| {
			readonly status: typeof AuthRuntimeResolutionStatus.READY;
			readonly attempt: number;
			readonly runtime: Runtime;
	  }
	| {
			readonly status: typeof AuthRuntimeResolutionStatus.FAILED;
			readonly attempt: number;
			readonly error: unknown;
	  };

type AuthRuntimeResolutionAction<Runtime> =
	| {readonly type: 'retry'}
	| {readonly type: 'resolved'; readonly attempt: number; readonly runtime: Runtime}
	| {readonly type: 'failed'; readonly attempt: number; readonly error: unknown};

interface AuthRuntimeResolution<Runtime> {
	readonly state: AuthRuntimeResolutionState<Runtime>;
	retry(): void;
}

class InvalidAuthDocumentLocationError extends Error {
	constructor(reason: string) {
		super(`Cannot resolve the browser authentication instance: ${reason}`);
		this.name = 'InvalidAuthDocumentLocationError';
	}
}

class DesktopAuthRuntimeUnavailableError extends Error {
	constructor() {
		super('Desktop authentication cannot read the initial runtime target');
		this.name = 'DesktopAuthRuntimeUnavailableError';
	}
}

function reduceAuthRuntimeResolution<Runtime>(
	state: AuthRuntimeResolutionState<Runtime>,
	action: AuthRuntimeResolutionAction<Runtime>,
): AuthRuntimeResolutionState<Runtime> {
	if (action.type === 'retry') {
		return {status: AuthRuntimeResolutionStatus.LOADING, attempt: state.attempt + 1};
	}
	if (state.status !== AuthRuntimeResolutionStatus.LOADING || action.attempt !== state.attempt) {
		return state;
	}
	if (action.type === 'resolved') {
		return {
			status: AuthRuntimeResolutionStatus.READY,
			attempt: action.attempt,
			runtime: action.runtime,
		};
	}
	return {
		status: AuthRuntimeResolutionStatus.FAILED,
		attempt: action.attempt,
		error: action.error,
	};
}

interface WarmAuthRuntime {
	readonly desktop: boolean;
	readonly runtime: RuntimeConfigSnapshot | null;
	readonly resolvedAt: number;
	readonly defaultSnapshot: RuntimeConfigSnapshot | null;
}

const WARM_AUTH_RUNTIME_MAX_AGE_MS = 60_000;

let warmAuthRuntime: WarmAuthRuntime | null = null;
interface DesktopAuthRuntime {
	readonly initialSnapshot: RuntimeConfigSnapshot | null;
	readonly defaultSnapshot: RuntimeConfigSnapshot | null;
}

function readWarmAuthRuntime(desktop: boolean): WarmAuthRuntime | null {
	const warm = warmAuthRuntime;
	if (warm === null || warm.desktop !== desktop) {
		return null;
	}
	const age = Date.now() - warm.resolvedAt;
	if (age < 0 || age > WARM_AUTH_RUNTIME_MAX_AGE_MS) {
		return null;
	}
	return warm;
}

function useAuthRuntimeResolution<Runtime>(
	resolveRuntime: (signal: AbortSignal) => Promise<Runtime>,
	readInitialRuntime: () => {readonly runtime: Runtime} | null,
): AuthRuntimeResolution<Runtime> {
	const [state, dispatch] = useReducer(
		reduceAuthRuntimeResolution<Runtime>,
		readInitialRuntime,
		(read): AuthRuntimeResolutionState<Runtime> => {
			const initial = read();
			if (initial === null) {
				return {status: AuthRuntimeResolutionStatus.LOADING, attempt: 0};
			}
			return {status: AuthRuntimeResolutionStatus.READY, attempt: 0, runtime: initial.runtime};
		},
	);
	useEffect(() => {
		if (state.status !== AuthRuntimeResolutionStatus.LOADING) {
			return;
		}
		const controller = new AbortController();
		const attempt = state.attempt;
		void resolveRuntime(controller.signal).then(
			(runtime) => dispatch({type: 'resolved', attempt, runtime}),
			(error: unknown) => {
				if (!controller.signal.aborted) {
					dispatch({type: 'failed', attempt, error});
				}
			},
		);
		return () => controller.abort();
	}, [resolveRuntime, state.attempt, state.status]);
	const retry = useCallback(() => dispatch({type: 'retry'}), []);
	return {state, retry};
}

function browserAuthDocumentOrigin(): string {
	if (typeof window === 'undefined') {
		throw new InvalidAuthDocumentLocationError('the document is unavailable');
	}
	const documentUrl = new URL(window.location.href);
	if (documentUrl.protocol !== 'https:' && documentUrl.protocol !== 'http:') {
		throw new InvalidAuthDocumentLocationError(`unsupported document protocol "${documentUrl.protocol}"`);
	}
	return documentUrl.origin;
}

async function resolveBrowserAuthRuntime(signal: AbortSignal): Promise<RuntimeConfigSnapshot> {
	const resolution = await InstanceSnapshotStore.resolve({input: browserAuthDocumentOrigin(), signal});
	return resolution.snapshot;
}

async function resolveDesktopAuthRuntime(signal: AbortSignal): Promise<DesktopAuthRuntime> {
	const api = getElectronAPI()?.desktopRuntimeConfig;
	if (api === undefined) {
		throw new DesktopAuthRuntimeUnavailableError();
	}
	const initialInput = await api.initialInput();
	signal.throwIfAborted();
	if (initialInput !== null) {
		const resolution = await InstanceSnapshotStore.resolve({input: initialInput, signal});
		return {initialSnapshot: resolution.snapshot, defaultSnapshot: null};
	}
	if (Accounts.getAllAccounts().length > 0 || (await loadKnownInstances()).length > 0) {
		return {initialSnapshot: null, defaultSnapshot: null};
	}
	const defaultInput = await api.defaultInput?.();
	signal.throwIfAborted();
	if (!defaultInput) return {initialSnapshot: null, defaultSnapshot: null};
	try {
		const defaultSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
		const resolution = await InstanceSnapshotStore.resolve({input: defaultInput, signal: defaultSignal});
		signal.throwIfAborted();
		return {initialSnapshot: null, defaultSnapshot: resolution.snapshot};
	} catch {
		signal.throwIfAborted();
		return {initialSnapshot: null, defaultSnapshot: null};
	}
}

export async function warmAuthRuntimeTarget(signal: AbortSignal): Promise<RuntimeConfigSnapshot | null> {
	const desktop = isDesktop();
	if (desktop) {
		const resolved = await resolveDesktopAuthRuntime(signal);
		warmAuthRuntime = {
			desktop,
			runtime: resolved.initialSnapshot,
			defaultSnapshot: resolved.defaultSnapshot,
			resolvedAt: Date.now(),
		};
		return resolved.initialSnapshot ?? resolved.defaultSnapshot;
	}
	const runtime = await resolveBrowserAuthRuntime(signal);
	warmAuthRuntime = {desktop, runtime, defaultSnapshot: null, resolvedAt: Date.now()};
	return runtime;
}

function readWarmDesktopAuthRuntime(): {readonly runtime: DesktopAuthRuntime} | null {
	const warm = readWarmAuthRuntime(true);
	return warm ? {runtime: {initialSnapshot: warm.runtime, defaultSnapshot: warm.defaultSnapshot}} : null;
}

function readWarmBrowserAuthRuntime(): {readonly runtime: RuntimeConfigSnapshot} | null {
	const warm = readWarmAuthRuntime(false);
	if (warm === null || warm.runtime === null) {
		return null;
	}
	return {runtime: warm.runtime};
}

function ResolvedDesktopAuthRuntimeTargetBoundary({
	runtime,
	children,
}: {
	readonly runtime: DesktopAuthRuntime;
	readonly children: ReactNode;
}) {
	const [target] = useState(() => {
		const target = AuthRuntimeTarget.forInstanceSelection(runtime.initialSnapshot);
		if (runtime.initialSnapshot === null && runtime.defaultSnapshot !== null) target.select(runtime.defaultSnapshot);
		return target;
	});
	return (
		<AuthRuntimeTargetProvider
			target={target}
			data-flx="auth.flow.auth-runtime-target-boundary.resolved-desktop-auth-runtime-target-boundary.auth-runtime-target-provider"
		>
			{children}
		</AuthRuntimeTargetProvider>
	);
}

function ResolvedBrowserAuthRuntimeTargetBoundary({
	snapshot,
	children,
}: {
	readonly snapshot: RuntimeConfigSnapshot;
	readonly children: ReactNode;
}) {
	const [target] = useState(() => AuthRuntimeTarget.forBrowserDocument(snapshot));
	return (
		<AuthRuntimeTargetProvider
			target={target}
			data-flx="auth.flow.auth-runtime-target-boundary.resolved-browser-auth-runtime-target-boundary.auth-runtime-target-provider"
		>
			{children}
		</AuthRuntimeTargetProvider>
	);
}

function DesktopAuthRuntimeTargetBoundary({children}: {readonly children: ReactNode}) {
	const {state, retry} = useAuthRuntimeResolution(resolveDesktopAuthRuntime, readWarmDesktopAuthRuntime);
	if (state.status === AuthRuntimeResolutionStatus.LOADING) {
		return <AuthShellLoadingState data-flx="auth.flow.auth-runtime-target-boundary.desktop-loading" />;
	}
	if (state.status === AuthRuntimeResolutionStatus.FAILED) {
		return (
			<AuthRouteLoadError
				error={state.error}
				retry={retry}
				data-flx="auth.flow.auth-runtime-target-boundary.desktop-error"
			/>
		);
	}
	return (
		<ResolvedDesktopAuthRuntimeTargetBoundary
			runtime={state.runtime}
			data-flx="auth.flow.auth-runtime-target-boundary.desktop-auth-runtime-target-boundary.resolved-desktop-auth-runtime-target-boundary"
		>
			{children}
		</ResolvedDesktopAuthRuntimeTargetBoundary>
	);
}

function BrowserAuthRuntimeTargetBoundary({children}: {readonly children: ReactNode}) {
	const {state, retry} = useAuthRuntimeResolution(resolveBrowserAuthRuntime, readWarmBrowserAuthRuntime);
	if (state.status === AuthRuntimeResolutionStatus.LOADING) {
		return <AuthShellLoadingState data-flx="auth.flow.auth-runtime-target-boundary.browser-loading" />;
	}
	if (state.status === AuthRuntimeResolutionStatus.FAILED) {
		return (
			<AuthRouteLoadError
				error={state.error}
				retry={retry}
				data-flx="auth.flow.auth-runtime-target-boundary.browser-error"
			/>
		);
	}
	return (
		<ResolvedBrowserAuthRuntimeTargetBoundary
			snapshot={state.runtime}
			data-flx="auth.flow.auth-runtime-target-boundary.browser-auth-runtime-target-boundary.resolved-browser-auth-runtime-target-boundary"
		>
			{children}
		</ResolvedBrowserAuthRuntimeTargetBoundary>
	);
}

export function AuthRuntimeTargetBoundary({children}: {readonly children: ReactNode}) {
	if (isDesktop()) {
		return (
			<DesktopAuthRuntimeTargetBoundary data-flx="auth.flow.auth-runtime-target-boundary.desktop-auth-runtime-target-boundary">
				{children}
			</DesktopAuthRuntimeTargetBoundary>
		);
	}
	return (
		<BrowserAuthRuntimeTargetBoundary data-flx="auth.flow.auth-runtime-target-boundary.browser-auth-runtime-target-boundary">
			{children}
		</BrowserAuthRuntimeTargetBoundary>
	);
}
