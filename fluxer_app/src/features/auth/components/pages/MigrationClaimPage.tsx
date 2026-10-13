// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import type {RuntimeConfigSnapshot} from '@app/features/app/state/InstanceSnapshotStore';
import styles from '@app/features/auth/components/pages/ResetPasswordPage.module.css';
import FormField from '@app/features/auth/flow/AuthFormField';
import {AuthRouterLink} from '@app/features/auth/flow/AuthRouterLink';
import {AuthRuntimeTargetGate} from '@app/features/auth/flow/AuthRuntimeTargetGate';
import {DateOfBirthField} from '@app/features/auth/flow/DateOfBirthField';
import {takeMigrationClaimLink} from '@app/features/auth/flow/MigrationClaimBootstrap';
import {MigrationClaimClient, type MigrationClaimField} from '@app/features/auth/flow/MigrationClaimClient';
import {MigrationClaimFlow, type MigrationClaimView} from '@app/features/auth/flow/MigrationClaimFlow';
import {
	getRegistrationLegalConsentConfig,
	RegistrationLegalConsent,
} from '@app/features/auth/flow/RegistrationLegalConsent';
import {useAuthPresentation} from '@app/features/auth/flow/useAuthPresentation';
import Authentication from '@app/features/auth/state/Authentication';
import {AuthCardVariant} from '@app/features/auth/state/AuthLayoutContext';
import SessionManager from '@app/features/platform/state/AuthSession';
import {Button} from '@app/features/ui/button/Button';
import {useFluxerDocumentTitle} from '@app/features/window/hooks/useFluxerDocumentTitle';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {type FormEvent, useEffect, useId, useRef, useState} from 'react';
import {flushSync} from 'react-dom';

const EMPTY_FORM = {email: '', code: '', password: '', confirmation: '', year: '', month: '', day: '', consent: false};

const MigrationClaimPageContent = observer(function MigrationClaimPageContent({
	runtimeSnapshot,
}: {
	runtimeSnapshot: RuntimeConfigSnapshot | null;
}) {
	const {i18n} = useLingui();
	useAuthPresentation({variant: AuthCardVariant.STANDARD});
	const id = useId();
	const heading = useRef<HTMLHeadingElement>(null);
	const flow = useRef<MigrationClaimFlow | null>(null);
	const mounted = useRef(false);
	const [view, setView] = useState<MigrationClaimView | null>(null);
	const [form, setForm] = useState(EMPTY_FORM);
	const [mismatch, setMismatch] = useState(false);
	const [now, setNow] = useState(Date.now);
	const authenticated = Authentication.isAuthenticated;
	const initialized = SessionManager.isInitialized;
	const legal = runtimeSnapshot
		? getRegistrationLegalConsentConfig(runtimeSnapshot)
		: {termsUrl: null, privacyUrl: null, requirement: null};
	useFluxerDocumentTitle(i18n._(msg`Claim your migrated account`));

	function clear() {
		flow.current?.dispose();
		takeMigrationClaimLink();
		setForm(EMPTY_FORM);
		setMismatch(false);
		setView(flow.current?.view ?? {stage: 'stopped', busy: false, failure: 'missing'});
	}

	useEffect(() => {
		mounted.current = true;
		const hide = () => flushSync(clear);
		window.addEventListener('pagehide', hide);
		return () => {
			mounted.current = false;
			window.removeEventListener('pagehide', hide);
			// StrictMode replays effects immediately. Dispose only on a real departure.
			queueMicrotask(() => {
				if (!mounted.current) {
					flow.current?.dispose();
					takeMigrationClaimLink();
				}
			});
		};
	}, []);

	useEffect(() => {
		if (!initialized) {
			void SessionManager.initialize();
			return;
		}
		if (authenticated) {
			clear();
			return;
		}
		if (!flow.current) {
			try {
				flow.current = new MigrationClaimFlow(
					takeMigrationClaimLink(),
					new MigrationClaimClient(() => ({
						apiEndpoint: runtimeSnapshot!.apiEndpoint,
						apiVersion: runtimeSnapshot!.apiCodeVersion,
					})),
				);
				setView(flow.current.view);
			} catch {
				// Never render/log native exceptions or the original credential-bearing URL.
				takeMigrationClaimLink();
				setView({stage: 'stopped', busy: false, failure: 'unavailable'});
			}
		}
	}, [authenticated, initialized, runtimeSnapshot]);

	useEffect(() => {
		heading.current?.focus();
	}, [view?.stage, authenticated]);

	useEffect(() => {
		if (!view || view.stage === 'stopped' || view.stage === 'finished' || authenticated) return;
		const timer = window.setInterval(() => {
			const next = flow.current?.refresh();
			setNow(Date.now());
			if (next?.stage === 'stopped') setForm(EMPTY_FORM);
			if (next) setView(next);
		}, 1000);
		return () => window.clearInterval(timer);
	}, [view?.stage, authenticated]);

	async function run(action: (claim: MigrationClaimFlow) => Promise<void>) {
		if (!SessionManager.isInitialized || Authentication.isAuthenticated || !flow.current) return;
		const pending = action(flow.current);
		setView(flow.current.view);
		await pending;
		if (!mounted.current) return;
		if (Authentication.isAuthenticated) {
			clear();
			return;
		}
		const next = flow.current.view;
		setNow(Date.now());
		if (next.stage === 'finished' || next.stage === 'stopped') setForm(EMPTY_FORM);
		setView(next);
	}

	function sendEmail() {
		setForm((current) => ({...current, code: '', password: '', confirmation: ''}));
		setMismatch(false);
		void run((claim) => claim.requestEmail(form.email));
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		if (view?.stage === 'email') {
			sendEmail();
		} else if (view?.stage === 'complete') {
			if (form.password !== form.confirmation) {
				setMismatch(true);
				return;
			}
			setMismatch(false);
			void run((claim) =>
				claim.complete({
					code: form.code.trim(),
					password: form.password,
					date_of_birth:
						view.dateOfBirthRequired && form.year && form.month && form.day
							? `${form.year.padStart(4, '0')}-${form.month.padStart(2, '0')}-${form.day.padStart(2, '0')}`
							: undefined,
					consent: form.consent,
				}),
			);
		}
	}

	const update = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) =>
		setForm((current) => ({...current, [key]: value}));
	const fieldError = (field: MigrationClaimField) => {
		const failure = view?.fieldFailures?.find((entry) => entry.field === field);
		if (!failure) return undefined;
		if (failure.code === 'EMAIL_ALREADY_IN_USE')
			return i18n._(msg`This email is already in use. Choose another address or sign in to the existing account.`);
		if (failure.code === 'PASSWORD_IS_TOO_COMMON') return i18n._(msg`Choose a less common password.`);
		if (field === 'email') return i18n._(msg`Enter a valid email address that you can access.`);
		if (field === 'code') return i18n._(msg`Check the code in your latest verification email.`);
		if (field === 'password') return i18n._(msg`Choose a valid password of at least 8 characters.`);
		if (field === 'date_of_birth') return i18n._(msg`Check your birth date. The instance's age requirements apply.`);
		return i18n._(msg`Please agree to the instance's terms and privacy policy.`);
	};
	const failureMessage = () => {
		switch (view?.failure) {
			case 'uncertain':
				return i18n._(
					msg`Your claim may have completed, but we could not confirm it. Try normal sign-in with your email and password. If it did not complete, ask your administrator for a new private Discord link.`,
				);
			case 'invalid_form':
				return i18n._(msg`Check the details below and try again.`);
			case 'rate_limited':
				return i18n._(
					msg`Too many attempts. Wait a little before trying again. Your original link expiry still applies.`,
				);
			case 'unavailable':
				return i18n._(
					msg`Claiming is currently unavailable. If you already confirmed ownership, ask your administrator for a new private Discord link before trying again.`,
				);
			case 'expired':
				return view?.stage === 'email'
					? i18n._(msg`The email code expired. Request a new code before your original claim link expires.`)
					: i18n._(msg`This claim expired. Ask your administrator for a new private Discord link.`);
			case 'unsafe_location':
				return i18n._(
					msg`We could not safely clear this link from the address bar. Close this page and ask your administrator for help.`,
				);
			case 'missing':
				return i18n._(
					msg`Open the original private Discord link. Reloading or leaving this page discards claim credentials. If ownership was already confirmed, ask for a new link.`,
				);
			case 'invalid_link':
				return i18n._(
					msg`This claim link is invalid, expired, or already used. Ask your administrator for a new private Discord link.`,
				);
			default:
				return undefined;
		}
	};
	const resendSeconds = Math.max(0, Math.ceil(((view?.resendAvailableAt ?? 0) - now) / 1000));
	const deadline = view?.expiresAt
		? new Date(view.expiresAt).toLocaleTimeString(i18n.locale, {hour: '2-digit', minute: '2-digit'})
		: '';
	const message = failureMessage();

	return (
		<>
			<h1 ref={heading} tabIndex={-1} className={styles.title} data-flx="auth.migration-claim.title">
				{view?.stage === 'finished' ? <Trans>Your account is ready</Trans> : <Trans>Claim your migrated account</Trans>}
			</h1>
			{authenticated ? (
				<p className={styles.description} data-flx="auth.migration-claim.existing-session">
					<Trans>
						You are already signed in. Your current account will stay signed in. Open the original link from your
						private Discord message in a private or incognito browser window to claim the migrated account.
					</Trans>
				</p>
			) : !view ? (
				<p
					className={styles.statusMessage}
					data-flx="auth.migration-claim-page.migration-claim-page-content.status-message"
				>
					<Trans>Checking your current session…</Trans>
				</p>
			) : (
				<>
					{message && (
						<div className={styles.formError} role="alert" data-flx="auth.migration-claim.error">
							{message}
						</div>
					)}
					{view.stage === 'confirm' && (
						<div className={styles.form} data-flx="auth.migration-claim-page.migration-claim-page-content.form">
							<p
								className={styles.description}
								data-flx="auth.migration-claim-page.migration-claim-page-content.description"
							>
								<Trans>
									This private Discord link proves ownership of your migrated account. Confirm only if the link was sent
									to you. You will verify an email and choose a password next. This does not sign you in automatically.
								</Trans>
							</p>
							<Button
								fitContainer
								disabled={view.busy}
								submitting={view.busy}
								onClick={() => void run((claim) => claim.confirm())}
								data-flx="auth.migration-claim-page.migration-claim-page-content.button"
							>
								<Trans>Confirm ownership</Trans>
							</Button>
						</div>
					)}
					{(view.stage === 'email' || view.stage === 'complete') && (
						<form className={styles.form} onSubmit={submit} aria-busy={view.busy} data-flx="auth.migration-claim.form">
							<FormField
								name="username"
								label={i18n._(msg`Migrated username`)}
								value={view.username ?? ''}
								readOnly
								onChange={() => {}}
								data-flx="auth.migration-claim-page.migration-claim-page-content.form-field"
							/>
							<p
								className={styles.statusMessage}
								data-flx="auth.migration-claim-page.migration-claim-page-content.status-message--2"
							>
								<Trans>
									Your Discord identity is bound to this account. Claim expires at {deadline}, in your local time.
									Nothing is saved when you leave this page.
								</Trans>
							</p>
							<FormField
								id={`${id}-email`}
								name="email"
								type="email"
								autoComplete="email"
								required
								label={i18n._(msg`Email`)}
								value={form.email}
								readOnly={view.stage === 'complete'}
								disabled={view.busy}
								onChange={(value) => update('email', value)}
								error={fieldError('email')}
								data-flx="auth.migration-claim-page.migration-claim-page-content.form-field.update.email"
							/>
							{view.stage === 'email' ? (
								<Button
									type="submit"
									fitContainer
									disabled={view.busy || resendSeconds > 0}
									submitting={view.busy}
									data-flx="auth.migration-claim-page.migration-claim-page-content.button.submit"
								>
									<Trans>Send verification code</Trans>
								</Button>
							) : (
								<>
									<FormField
										id={`${id}-code`}
										name="code"
										autoComplete="one-time-code"
										maxLength={32}
										required
										label={i18n._(msg`Email verification code`)}
										value={form.code}
										disabled={view.busy}
										onChange={(value) => update('code', value)}
										error={fieldError('code')}
										data-flx="auth.migration-claim-page.migration-claim-page-content.form-field.update"
									/>
									<FormField
										id={`${id}-password`}
										name="password"
										type="password"
										autoComplete="new-password"
										minLength={8}
										required
										label={i18n._(msg`New password`)}
										value={form.password}
										disabled={view.busy}
										onChange={(value) => update('password', value)}
										error={fieldError('password')}
										data-flx="auth.migration-claim-page.migration-claim-page-content.form-field.update.password"
									/>
									<FormField
										id={`${id}-confirmation`}
										name="confirmation"
										type="password"
										autoComplete="new-password"
										required
										label={i18n._(msg`Confirm new password`)}
										value={form.confirmation}
										disabled={view.busy}
										onChange={(value) => update('confirmation', value)}
										error={mismatch ? i18n._(msg`Passwords do not match.`) : undefined}
										data-flx="auth.migration-claim-page.migration-claim-page-content.form-field.update.password--2"
									/>
									{view.dateOfBirthRequired && (
										<DateOfBirthField
											selectedYear={form.year}
											selectedMonth={form.month}
											selectedDay={form.day}
											onYearChange={(value) => update('year', value)}
											onMonthChange={(value) => update('month', value)}
											onDayChange={(value) => update('day', value)}
											error={fieldError('date_of_birth')}
											data-flx="auth.migration-claim-page.migration-claim-page-content.date-of-birth-field"
										/>
									)}
									<RegistrationLegalConsent
										checked={form.consent}
										config={legal}
										onChange={(value) => update('consent', value)}
										data-flx="auth.migration-claim-page.migration-claim-page-content.registration-legal-consent.update"
									/>
									{fieldError('consent') && (
										<p
											role="alert"
											className={styles.formError}
											data-flx="auth.migration-claim-page.migration-claim-page-content.form-error"
										>
											{fieldError('consent')}
										</p>
									)}
									<Button
										type="submit"
										fitContainer
										disabled={view.busy || (!!legal.requirement && !form.consent)}
										submitting={view.busy}
										data-flx="auth.migration-claim-page.migration-claim-page-content.button.submit--2"
									>
										<Trans>Finish claiming</Trans>
									</Button>
									<Button
										type="button"
										variant="secondary"
										disabled={view.busy || resendSeconds > 0}
										onClick={sendEmail}
										data-flx="auth.migration-claim-page.migration-claim-page-content.button.send-email"
									>
										<Trans>Resend email code</Trans>
									</Button>
									<Button
										type="button"
										variant="ghost"
										disabled={view.busy}
										onClick={() => {
											flow.current?.changeEmail();
											setForm((current) => ({...current, code: '', password: '', confirmation: ''}));
											setView(flow.current?.view ?? null);
										}}
										data-flx="auth.migration-claim-page.migration-claim-page-content.button.change-email"
									>
										<Trans>Use another email</Trans>
									</Button>
								</>
							)}
							{resendSeconds > 0 && (
								<p
									className={styles.statusMessage}
									data-flx="auth.migration-claim-page.migration-claim-page-content.status-message--3"
								>
									<Trans>You can request another email in {resendSeconds} seconds.</Trans>
								</p>
							)}
						</form>
					)}
					{view.stage === 'finished' && (
						<p
							className={styles.description}
							data-flx="auth.migration-claim-page.migration-claim-page-content.description--2"
						>
							<Trans>
								Your email is verified and your password is set. Sign in normally to open your migrated account. Your
								usual account security checks still apply.
							</Trans>
						</p>
					)}
				</>
			)}
			<div className={styles.footer} data-flx="auth.migration-claim-page.migration-claim-page-content.footer">
				<AuthRouterLink
					to={authenticated ? Routes.ME : Routes.LOGIN}
					className={styles.link}
					data-flx="auth.migration-claim-page.migration-claim-page-content.link"
				>
					{authenticated ? <Trans>Back to your current account</Trans> : <Trans>Go to sign-in</Trans>}
				</AuthRouterLink>
			</div>
		</>
	);
});

const MigrationClaimPage = observer(function MigrationClaimPage() {
	if (Authentication.isAuthenticated)
		return (
			<MigrationClaimPageContent
				runtimeSnapshot={null}
				data-flx="auth.migration-claim-page.migration-claim-page-content"
			/>
		);
	return (
		<AuthRuntimeTargetGate data-flx="auth.migration-claim-page.auth-runtime-target-gate">
			{(runtimeSnapshot) => (
				<MigrationClaimPageContent
					key={`${runtimeSnapshot.apiEndpoint}:${runtimeSnapshot.apiCodeVersion}`}
					runtimeSnapshot={runtimeSnapshot}
					data-flx="auth.migration-claim-page.migration-claim-page-content--2"
				/>
			)}
		</AuthRuntimeTargetGate>
	);
});

export default MigrationClaimPage;
