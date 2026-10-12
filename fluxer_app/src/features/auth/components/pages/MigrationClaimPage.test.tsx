// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {act, type InputHTMLAttributes, type ReactNode, StrictMode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	authenticated: false,
	initialized: true,
	take: vi.fn(() => ({status: 'ready', token: `mc1.${'A'.repeat(43)}`})),
	initialize: vi.fn(async () => {}),
}));

vi.mock('@app/app/Routes', () => ({Routes: {LOGIN: '/login', ME: '/channels/@me'}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {apiEndpoint: 'https://synthetic.example.invalid/api', apiCodeVersion: 1},
}));
vi.mock('@app/features/auth/state/Authentication', () => ({
	default: {
		get isAuthenticated() {
			return state.authenticated;
		},
	},
}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {
		get isInitialized() {
			return state.initialized;
		},
		initialize: state.initialize,
	},
}));
vi.mock('@app/features/auth/flow/MigrationClaimBootstrap', () => ({takeMigrationClaimLink: state.take}));
vi.mock('@app/features/window/hooks/useFluxerDocumentTitle', () => ({useFluxerDocumentTitle: () => {}}));
vi.mock('@app/features/auth/flow/useAuthCardPresentation', () => ({useAuthCardPresentation: () => {}}));
vi.mock('@lingui/core/macro', () => ({msg: (strings: TemplateStringsArray) => strings.join('')}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: ReactNode}) => <>{children}</>,
	useLingui: () => ({i18n: {_: (message: string) => message}}),
}));
vi.mock('@app/features/auth/flow/AuthRouterLink', () => ({
	AuthRouterLink: ({to, children}: {to: string; children: ReactNode}) => <a href={to}>{children}</a>,
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		children,
		fitContainer: _fit,
		submitting: _submitting,
		variant: _variant,
		...props
	}: {
		children: ReactNode;
		fitContainer?: boolean;
		submitting?: boolean;
		variant?: string;
	}) => <button {...props}>{children}</button>,
}));
vi.mock('@app/features/auth/flow/AuthFormField', () => ({
	default: ({
		label,
		error,
		onChange,
		...props
	}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
		label: string;
		error?: string;
		onChange: (value: string) => void;
	}) => (
		<label>
			{label}
			<input {...props} onChange={(event) => onChange(event.target.value)} />
			{error && <span role="alert">{error}</span>}
		</label>
	),
}));
vi.mock('@app/features/auth/flow/DateOfBirthField', () => ({DateOfBirthField: () => <p>Date of birth</p>}));
vi.mock('@app/features/auth/flow/RegistrationLegalConsent', () => ({
	getRegistrationLegalConsentConfig: () => ({requirement: null}),
	RegistrationLegalConsent: () => null,
}));

import MigrationClaimPage from './MigrationClaimPage';

let root: Root;
let container: HTMLDivElement;
let send: ReturnType<typeof vi.fn<typeof fetch>>;

function respond(url: string): Response {
	if (url.endsWith('/redeem'))
		return Response.json({
			proof: `mp1.${'A'.repeat(43)}`,
			expires_at: new Date(Date.now() + 900_000).toISOString(),
			username: 'synthetic-migrant',
			date_of_birth_required: false,
		});
	if (url.endsWith('/email'))
		return Response.json({
			challenge: `me1.${'A'.repeat(43)}`,
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			resend_available_at: new Date(Date.now() + 30_000).toISOString(),
		});
	return Response.json({user_id: '1400000000000000102', login_required: true});
}

async function mount(strict = false) {
	await act(async () =>
		root.render(
			strict ? (
				<StrictMode>
					<MigrationClaimPage />
				</StrictMode>
			) : (
				<MigrationClaimPage />
			),
		),
	);
}
async function click(text: string) {
	const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
	expect(button).toBeDefined();
	await act(async () => button!.click());
}
async function input(name: string, value: string) {
	const element = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
		element.dispatchEvent(new Event('input', {bubbles: true}));
	});
}
async function submit() {
	await act(async () =>
		container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
	);
}
async function emailStage() {
	await mount();
	await click('Confirm ownership');
}
async function completeStage() {
	await emailStage();
	await input('email', 'synthetic@example.invalid');
	await submit();
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	state.authenticated = false;
	state.initialized = true;
	state.take.mockClear();
	state.initialize.mockClear();
	send = vi.fn<typeof fetch>(async (url) => respond(String(url)));
	vi.stubGlobal('fetch', send);
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('Migration claim screen safety', () => {
	it('preserves an existing session and directs the original Discord link to a private window', async () => {
		state.authenticated = true;
		await mount();
		expect(container.textContent).toContain('Your current account will stay signed in.');
		expect(container.textContent).toContain('original link from your private Discord message');
		expect(container.textContent).toContain('private or incognito');
		expect(container.querySelector('button')).toBeNull();
		expect(container.querySelector('a')?.getAttribute('href')).toBe('/channels/@me');
		expect(send).not.toHaveBeenCalled();
		expect(state.authenticated).toBe(true);
	});

	it('does not consume a link or send any request before session initialization', async () => {
		state.initialized = false;
		await mount();
		expect(container.textContent).toContain('Checking your current session');
		expect(state.take).not.toHaveBeenCalled();
		expect(state.initialize).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
	});

	it('requires explicit confirmation and survives StrictMode effect replay without losing the link', async () => {
		await mount(true);
		expect(state.take).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
		await click('Confirm ownership');
		expect(send).toHaveBeenCalledOnce();
		expect(container.querySelector<HTMLInputElement>('input[name="username"]')?.readOnly).toBe(true);
		expect(container.textContent).not.toContain(`mc1.${'A'.repeat(43)}`);
	});

	it('rechecks the current session at the action boundary, even before observer rendering', async () => {
		await mount();
		state.authenticated = true;
		await click('Confirm ownership');
		expect(send).not.toHaveBeenCalled();
	});

	it('completes through the anonymous transport and returns to normal sign-in, never a session switch', async () => {
		await completeStage();
		await input('code', 'synthetic-code');
		await input('password', 'Synthetic password! 492');
		await input('confirmation', 'Synthetic password! 492');
		await submit();
		expect(send).toHaveBeenCalledTimes(3);
		expect(JSON.parse(send.mock.calls[2]![1]!.body as string).consent).toBe(false);
		expect(container.textContent).toContain('Your account is ready');
		expect(container.querySelector('input')).toBeNull();
		expect(container.querySelector('a')?.getAttribute('href')).toBe('/login');
		expect(state.authenticated).toBe(false);
	});

	it('refuses mismatched passwords locally without another request', async () => {
		await completeStage();
		await input('password', 'Synthetic password! 492');
		await input('confirmation', 'different');
		await submit();
		expect(container.textContent).toContain('Passwords do not match.');
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('pagehide clears secrets and the form before a back-forward cache snapshot; late responses cannot restore it', async () => {
		await completeStage();
		await input('password', 'Synthetic password! 492');
		await input('code', 'synthetic-code');
		await act(async () => window.dispatchEvent(new Event('pagehide')));
		expect(container.querySelector('input')).toBeNull();
		expect(container.textContent).toContain('Reloading or leaving this page discards claim credentials');
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('aborts a pending request when leaving and never renders a late success', async () => {
		let resolve!: (value: Response) => void;
		send.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await mount();
		await click('Confirm ownership');
		const signal = send.mock.calls[0]![1]!.signal!;
		await act(async () => window.dispatchEvent(new Event('pagehide')));
		expect(signal.aborted).toBe(true);
		await act(async () => resolve(respond('/redeem')));
		expect(container.querySelector('input')).toBeNull();
	});

	it('an uncertain completion clears the form and explains ordinary sign-in without replay', async () => {
		await completeStage();
		await input('code', 'synthetic-code');
		await input('password', 'Synthetic password! 492');
		await input('confirmation', 'Synthetic password! 492');
		send.mockRejectedValueOnce(new Error('PRIVATE provider body'));
		await submit();
		expect(container.textContent).toContain('Your claim may have completed');
		expect(container.textContent).not.toContain('PRIVATE');
		expect(container.querySelector('input')).toBeNull();
		expect(send).toHaveBeenCalledTimes(3);
	});
});
