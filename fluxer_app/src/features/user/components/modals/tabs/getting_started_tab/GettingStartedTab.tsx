// SPDX-License-Identifier: AGPL-3.0-or-later

import {SettingsSection} from '@app/features/app/components/dialogs/shared/SettingsSection';
import {SettingsTabContainer} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import Guilds from '@app/features/guild/state/Guilds';
import * as NavigationCommands from '@app/features/navigation/commands/NavigationCommands';
import * as NotificationUtils from '@app/features/notification/utils/NotificationUtils';
import {
	getPilotNotificationPresetLevels,
	type PilotNotificationPreset,
	resolvePilotNotificationPreset,
} from '@app/features/onboarding/PilotNotificationPreset';
import {
	getPilotOnboardingDeviceState,
	setPilotOnboardingDeviceState,
} from '@app/features/onboarding/PilotOnboardingDeviceState';
import {
	getPilotOnboardingProgress,
	setPilotOnboardingProgress,
} from '@app/features/onboarding/PilotOnboardingPreferences';
import {
	acknowledgePilotOnboardingStep,
	completePilotOnboarding,
	dismissPilotOnboarding,
	getEnabledPilotOnboardingSteps,
	type PilotOnboardingProgress,
	type PilotOnboardingStepId,
} from '@app/features/onboarding/PilotOnboardingState';
import {ComponentBus} from '@app/features/platform/utils/ComponentBus';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {isDesktop} from '@app/features/ui/utils/NativeUtils';
import * as UserGuildSettingsCommands from '@app/features/user/commands/UserGuildSettingsCommands';
import type {UserSettingsTabType} from '@app/features/user/components/settings_utils/SettingsSectionRegistry';
import UserGuildSettings from '@app/features/user/state/UserGuildSettings';
import Users from '@app/features/user/state/Users';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {
	ArrowRightIcon,
	BellIcon,
	CameraIcon,
	CheckCircleIcon,
	CircleIcon,
	IdentificationCardIcon,
	ShieldCheckIcon,
	UsersThreeIcon,
} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useMemo, useState} from 'react';
import styles from './GettingStartedTab.module.css';

const SAVE_FAILED_DESCRIPTOR = msg({
	message: "We couldn't save that yet. Check your connection and try again.",
	comment: 'Getting Started error shown when synced onboarding progress could not be saved.',
});

const ICON_SIZE = remFromPx(20);

type StepStatus = 'complete' | 'attention' | 'skipped';
interface StepRowProps {
	icon: React.ReactNode;
	title: React.ReactNode;
	description: React.ReactNode;
	status: StepStatus;
	children: React.ReactNode;
}

const StepStatusPill: React.FC<{status: StepStatus}> = ({status}) => {
	if (status === 'complete') {
		return (
			<span
				className={clsx(styles.statusPill, styles.statusComplete)}
				data-flx="user.getting-started-tab.getting-started-tab.step-status-pill.status-pill"
			>
				<CheckCircleIcon
					size={remFromPx(14)}
					weight="fill"
					data-flx="user.getting-started-tab.getting-started-tab.step-status-pill.check-circle-icon"
				/>
				<Trans>Ready</Trans>
			</span>
		);
	}
	if (status === 'skipped') {
		return (
			<span
				className={clsx(styles.statusPill, styles.statusSkipped)}
				data-flx="user.getting-started-tab.getting-started-tab.step-status-pill.status-pill--2"
			>
				<CircleIcon
					size={remFromPx(14)}
					weight="fill"
					data-flx="user.getting-started-tab.getting-started-tab.step-status-pill.circle-icon"
				/>
				<Trans>Do later</Trans>
			</span>
		);
	}
	return (
		<span
			className={clsx(styles.statusPill, styles.statusAttention)}
			data-flx="user.getting-started-tab.getting-started-tab.step-status-pill.status-pill--3"
		>
			<Trans>Next step</Trans>
		</span>
	);
};

const StepRow: React.FC<StepRowProps> = ({icon, title, description, status, children}) => (
	<div className={styles.stepRow} data-flx="user.getting-started-tab.getting-started-tab.step-row.step-row">
		<div className={styles.stepIcon} data-flx="user.getting-started-tab.getting-started-tab.step-row.step-icon">
			{icon}
		</div>
		<div className={styles.stepCopy} data-flx="user.getting-started-tab.getting-started-tab.step-row.step-copy">
			<div
				className={styles.stepTitleRow}
				data-flx="user.getting-started-tab.getting-started-tab.step-row.step-title-row"
			>
				<h3 className={styles.stepTitle} data-flx="user.getting-started-tab.getting-started-tab.step-row.step-title">
					{title}
				</h3>
				<StepStatusPill
					status={status}
					data-flx="user.getting-started-tab.getting-started-tab.step-row.step-status-pill"
				/>
			</div>
			<p
				className={styles.stepDescription}
				data-flx="user.getting-started-tab.getting-started-tab.step-row.step-description"
			>
				{description}
			</p>
		</div>
		<div className={styles.stepActions} data-flx="user.getting-started-tab.getting-started-tab.step-row.step-actions">
			{children}
		</div>
	</div>
);

function getNotificationPermissionGranted(): boolean {
	return isDesktop() || (typeof Notification !== 'undefined' && Notification.permission === 'granted');
}

function getNotificationPreset(primaryGuildId: string | null): PilotNotificationPreset | null {
	if (!primaryGuildId) return null;
	return resolvePilotNotificationPreset({
		community: UserGuildSettings.getGuildSettings(primaryGuildId).message_notifications,
		directMessages: UserGuildSettings.getGuildSettings(null).message_notifications,
	});
}

const GettingStartedTab: React.FC = observer(() => {
	const {i18n} = useLingui();
	const config = RuntimeConfig.onboarding;
	const currentUser = Users.currentUser;
	const [progress, setProgress] = useState<PilotOnboardingProgress>(() => getPilotOnboardingProgress());
	const [deviceState, setDeviceState] = useState(() =>
		currentUser
			? getPilotOnboardingDeviceState({
					instanceDomain: RuntimeConfig.localInstanceDomain,
					userId: currentUser.id,
					version: config.version,
				})
			: {notificationTested: false, mediaChecked: false},
	);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const enabledSteps = useMemo(() => getEnabledPilotOnboardingSteps(config), [config]);
	const acknowledgedSteps = new Set(progress.acknowledgedStepIds);
	const primaryGuild = config.primary_guild_id ? Guilds.getGuild(config.primary_guild_id) : undefined;
	const notificationPreset = getNotificationPreset(config.primary_guild_id);

	if (!currentUser) return null;

	const persistProgress = async (next: PilotOnboardingProgress): Promise<boolean> => {
		setSaving(true);
		setSaveError(null);
		try {
			await setPilotOnboardingProgress(next);
			setProgress(next);
			return true;
		} catch {
			setSaveError(i18n._(SAVE_FAILED_DESCRIPTOR));
			return false;
		} finally {
			setSaving(false);
		}
	};

	const acknowledgeStep = async (stepId: PilotOnboardingStepId) => {
		await persistProgress(acknowledgePilotOnboardingStep(progress, stepId));
	};

	const updateDeviceState = (update: Partial<typeof deviceState>) => {
		const next = {...deviceState, ...update};
		setPilotOnboardingDeviceState(
			{instanceDomain: RuntimeConfig.localInstanceDomain, userId: currentUser.id, version: config.version},
			next,
		);
		setDeviceState(next);
	};

	const openSettings = (tab: UserSettingsTabType, section?: string) => {
		ComponentBus.dispatch('USER_SETTINGS_TAB_SELECT', {tab, section});
	};

	const openCommunityChannel = (channelId: string | null) => {
		if (!config.primary_guild_id) return;
		ModalCommands.pop();
		NavigationCommands.selectChannel(config.primary_guild_id, channelId);
	};

	const handleNotificationTest = async () => {
		await NotificationUtils.requestPermission(i18n);
		if (getNotificationPermissionGranted()) updateDeviceState({notificationTested: true});
	};

	const applyNotificationPreset = (preset: PilotNotificationPreset) => {
		if (!config.primary_guild_id) return;
		const levels = getPilotNotificationPresetLevels(preset);
		UserGuildSettingsCommands.updateGuildSettings(
			config.primary_guild_id,
			{message_notifications: levels.community, muted: false},
			{persistImmediately: true},
		);
		UserGuildSettingsCommands.updateGuildSettings(
			null,
			{message_notifications: levels.directMessages, muted: false},
			{persistImmediately: true},
		);
	};

	const actualCompletion: Record<PilotOnboardingStepId, boolean> = {
		profile: Boolean(currentUser.globalName && currentUser.avatar),
		security: currentUser.mfaEnabled === true,
		notifications: getNotificationPermissionGranted() && deviceState.notificationTested && notificationPreset !== null,
		media: deviceState.mediaChecked,
		community: Boolean(primaryGuild && acknowledgedSteps.has('community')),
	};
	const isStepDone = (stepId: PilotOnboardingStepId) => actualCompletion[stepId] || acknowledgedSteps.has(stepId);
	const completedCount = enabledSteps.filter(isStepDone).length;
	const allComplete = completedCount === enabledSteps.length;
	const progressPercent = enabledSteps.length === 0 ? 100 : Math.round((completedCount / enabledSteps.length) * 100);
	const getStepStatus = (stepId: PilotOnboardingStepId): StepStatus => {
		if (actualCompletion[stepId]) return 'complete';
		return acknowledgedSteps.has(stepId) ? 'skipped' : 'attention';
	};

	const handleFinish = async () => {
		if (!allComplete) return;
		if (await persistProgress(completePilotOnboarding(progress, config.version))) ModalCommands.pop();
	};

	const handleDismiss = async () => {
		if (await persistProgress(dismissPilotOnboarding(progress, config.version))) ModalCommands.pop();
	};

	return (
		<SettingsTabContainer
			className={styles.container}
			data-flx="user.getting-started-tab.getting-started-tab.container"
		>
			<div className={styles.hero} data-flx="user.getting-started-tab.getting-started-tab.hero">
				<div
					className={styles.brandMark}
					aria-hidden="true"
					data-flx="user.getting-started-tab.getting-started-tab.brand-mark"
				>
					{RuntimeConfig.iconUrl ? (
						<img src={RuntimeConfig.iconUrl} alt="" data-flx="user.getting-started-tab.getting-started-tab.img" />
					) : (
						<UsersThreeIcon
							size={remFromPx(30)}
							weight="duotone"
							data-flx="user.getting-started-tab.getting-started-tab.users-three-icon"
						/>
					)}
				</div>
				<div className={styles.heroCopy} data-flx="user.getting-started-tab.getting-started-tab.hero-copy">
					<span className={styles.eyebrow} data-flx="user.getting-started-tab.getting-started-tab.eyebrow">
						<Trans>Private community setup</Trans>
					</span>
					<h2 className={styles.heroTitle} data-flx="user.getting-started-tab.getting-started-tab.hero-title">
						<Trans>Welcome to {RuntimeConfig.productName}</Trans>
					</h2>
					<p
						className={styles.heroDescription}
						data-flx="user.getting-started-tab.getting-started-tab.hero-description"
					>
						{config.welcome_message ?? <Trans>Let’s make sure your account and this device are ready.</Trans>}
					</p>
					{config.operator_name || config.availability_message ? (
						<p className={styles.operatorLine} data-flx="user.getting-started-tab.getting-started-tab.operator-line">
							{config.operator_name ? <Trans>Operated by {config.operator_name}.</Trans> : null}{' '}
							{config.availability_message}
						</p>
					) : null}
				</div>
				<div
					className={styles.progressPanel}
					role="status"
					aria-label={i18n._(msg`Setup progress: ${progressPercent}%`)}
					data-flx="user.getting-started-tab.getting-started-tab.progress-panel"
				>
					<div
						className={styles.progressSummary}
						data-flx="user.getting-started-tab.getting-started-tab.progress-summary"
					>
						<strong data-flx="user.getting-started-tab.getting-started-tab.strong">
							{completedCount}/{enabledSteps.length}
						</strong>
						<span data-flx="user.getting-started-tab.getting-started-tab.span">
							<Trans>steps ready</Trans>
						</span>
					</div>
					<div
						className={styles.progressTrack}
						aria-hidden="true"
						data-flx="user.getting-started-tab.getting-started-tab.progress-track"
					>
						<div
							className={styles.progressValue}
							style={{width: `${progressPercent}%`}}
							data-flx="user.getting-started-tab.getting-started-tab.progress-value"
						/>
					</div>
				</div>
			</div>

			<SettingsSection
				id="getting-started-checklist"
				title={<Trans>Your setup checklist</Trans>}
				data-flx="user.getting-started-tab.getting-started-tab.getting-started-checklist"
			>
				<div className={styles.stepList} data-flx="user.getting-started-tab.getting-started-tab.step-list">
					{config.steps.profile ? (
						<StepRow
							icon={
								<IdentificationCardIcon
									size={ICON_SIZE}
									weight="duotone"
									data-flx="user.getting-started-tab.getting-started-tab.identification-card-icon"
								/>
							}
							title={<Trans>Complete your profile</Trans>}
							description={
								<Trans>
									Add a display name and avatar so friends can recognize you. Status and privacy choices remain
									optional.
								</Trans>
							}
							status={getStepStatus('profile')}
							data-flx="user.getting-started-tab.getting-started-tab.step-row"
						>
							<Button
								small
								variant="secondary"
								onClick={() => openSettings('my_profile')}
								rightIcon={<ArrowRightIcon data-flx="user.getting-started-tab.getting-started-tab.arrow-right-icon" />}
								data-flx="user.getting-started-tab.getting-started-tab.button.open-settings"
							>
								<Trans>Open profile</Trans>
							</Button>
							{!actualCompletion.profile && !acknowledgedSteps.has('profile') ? (
								<Button
									small
									variant="ghost"
									onClick={() => void acknowledgeStep('profile')}
									data-flx="user.getting-started-tab.getting-started-tab.button"
								>
									<Trans>Do later</Trans>
								</Button>
							) : null}
						</StepRow>
					) : null}

					{config.steps.security ? (
						<StepRow
							icon={
								<ShieldCheckIcon
									size={ICON_SIZE}
									weight="duotone"
									data-flx="user.getting-started-tab.getting-started-tab.shield-check-icon"
								/>
							}
							title={<Trans>Secure your account</Trans>}
							description={
								<Trans>Review your password, multi-factor authentication, recovery codes, and signed-in devices.</Trans>
							}
							status={getStepStatus('security')}
							data-flx="user.getting-started-tab.getting-started-tab.step-row--2"
						>
							<Button
								small
								variant="secondary"
								onClick={() => openSettings('account_security', 'security')}
								rightIcon={
									<ArrowRightIcon data-flx="user.getting-started-tab.getting-started-tab.arrow-right-icon--2" />
								}
								data-flx="user.getting-started-tab.getting-started-tab.button.open-settings--2"
							>
								<Trans>Review security</Trans>
							</Button>
							{config.mfa_policy !== 'required' && !actualCompletion.security && !acknowledgedSteps.has('security') ? (
								<Button
									small
									variant="ghost"
									onClick={() => void acknowledgeStep('security')}
									data-flx="user.getting-started-tab.getting-started-tab.button--2"
								>
									<Trans>Do later</Trans>
								</Button>
							) : null}
						</StepRow>
					) : null}

					{config.steps.notifications ? (
						<StepRow
							icon={
								<BellIcon
									size={ICON_SIZE}
									weight="duotone"
									data-flx="user.getting-started-tab.getting-started-tab.bell-icon"
								/>
							}
							title={<Trans>Test notifications</Trans>}
							description={
								<Trans>
									Choose a starting point, then test this device. You can fine-tune each community and channel later.
								</Trans>
							}
							status={getStepStatus('notifications')}
							data-flx="user.getting-started-tab.getting-started-tab.step-row--3"
						>
							<div
								className={styles.presetGroup}
								role="group"
								aria-label={i18n._(msg`Notification preset`)}
								data-flx="user.getting-started-tab.getting-started-tab.preset-group"
							>
								<button
									type="button"
									className={clsx(
										styles.presetButton,
										notificationPreset === 'everything' && styles.presetButtonSelected,
									)}
									aria-pressed={notificationPreset === 'everything'}
									disabled={!primaryGuild}
									onClick={() => applyNotificationPreset('everything')}
									data-flx="user.getting-started-tab.getting-started-tab.preset-button.apply-notification-preset"
								>
									<Trans>Everything</Trans>
								</button>
								<button
									type="button"
									className={clsx(
										styles.presetButton,
										notificationPreset === 'mentions_dms' && styles.presetButtonSelected,
									)}
									aria-pressed={notificationPreset === 'mentions_dms'}
									disabled={!primaryGuild}
									onClick={() => applyNotificationPreset('mentions_dms')}
									data-flx="user.getting-started-tab.getting-started-tab.preset-button.apply-notification-preset--2"
								>
									<Trans>Mentions & DMs</Trans>
								</button>
								<button
									type="button"
									className={clsx(styles.presetButton, notificationPreset === 'quiet' && styles.presetButtonSelected)}
									aria-pressed={notificationPreset === 'quiet'}
									disabled={!primaryGuild}
									onClick={() => applyNotificationPreset('quiet')}
									data-flx="user.getting-started-tab.getting-started-tab.preset-button.apply-notification-preset--3"
								>
									<Trans>Quiet</Trans>
								</button>
							</div>
							<Button
								small
								variant="secondary"
								onClick={() => void handleNotificationTest()}
								data-flx="user.getting-started-tab.getting-started-tab.button--3"
							>
								<Trans>Allow & test</Trans>
							</Button>
							<Button
								small
								variant="ghost"
								onClick={() => openSettings('notifications')}
								data-flx="user.getting-started-tab.getting-started-tab.button.open-settings--3"
							>
								<Trans>Preferences</Trans>
							</Button>
							{!actualCompletion.notifications && !acknowledgedSteps.has('notifications') ? (
								<Button
									small
									variant="ghost"
									onClick={() => void acknowledgeStep('notifications')}
									data-flx="user.getting-started-tab.getting-started-tab.button--4"
								>
									<Trans>Do later</Trans>
								</Button>
							) : null}
						</StepRow>
					) : null}

					{config.steps.media ? (
						<StepRow
							icon={
								<CameraIcon
									size={ICON_SIZE}
									weight="duotone"
									data-flx="user.getting-started-tab.getting-started-tab.camera-icon"
								/>
							}
							title={<Trans>Check voice & video</Trans>}
							description={
								<Trans>Confirm your microphone, speaker, and camera on this device. A camera is optional.</Trans>
							}
							status={getStepStatus('media')}
							data-flx="user.getting-started-tab.getting-started-tab.step-row--4"
						>
							<Button
								small
								variant="secondary"
								onClick={() => openSettings('support_center', 'system-check')}
								rightIcon={
									<ArrowRightIcon data-flx="user.getting-started-tab.getting-started-tab.arrow-right-icon--3" />
								}
								data-flx="user.getting-started-tab.getting-started-tab.button.open-settings--4"
							>
								<Trans>Check my setup</Trans>
							</Button>
							{!actualCompletion.media ? (
								<Button
									small
									variant="ghost"
									onClick={() => updateDeviceState({mediaChecked: true})}
									data-flx="user.getting-started-tab.getting-started-tab.button.update-device-state"
								>
									<Trans>I checked it</Trans>
								</Button>
							) : null}
						</StepRow>
					) : null}

					{config.steps.community ? (
						<StepRow
							icon={
								<UsersThreeIcon
									size={ICON_SIZE}
									weight="duotone"
									data-flx="user.getting-started-tab.getting-started-tab.users-three-icon--2"
								/>
							}
							title={primaryGuild ? <Trans>Meet {primaryGuild.name}</Trans> : <Trans>Join the community</Trans>}
							description={
								<Trans>Read the welcome information and community rules, then find the important channels.</Trans>
							}
							status={getStepStatus('community')}
							data-flx="user.getting-started-tab.getting-started-tab.step-row--5"
						>
							<Button
								small
								variant="secondary"
								disabled={!primaryGuild}
								onClick={() => openCommunityChannel(config.rules_channel_id ?? config.introduction_channel_id)}
								rightIcon={
									<ArrowRightIcon data-flx="user.getting-started-tab.getting-started-tab.arrow-right-icon--4" />
								}
								data-flx="user.getting-started-tab.getting-started-tab.button.open-community-channel"
							>
								<Trans>Open community</Trans>
							</Button>
							{!acknowledgedSteps.has('community') ? (
								<Button
									small
									variant="ghost"
									onClick={() => void acknowledgeStep('community')}
									data-flx="user.getting-started-tab.getting-started-tab.button--5"
								>
									{primaryGuild ? <Trans>I’ve reviewed it</Trans> : <Trans>Do later</Trans>}
								</Button>
							) : null}
						</StepRow>
					) : null}
				</div>
			</SettingsSection>

			<div className={styles.footer} data-flx="user.getting-started-tab.getting-started-tab.footer">
				<div className={styles.footerCopy} data-flx="user.getting-started-tab.getting-started-tab.footer-copy">
					<strong data-flx="user.getting-started-tab.getting-started-tab.strong--2">
						{allComplete ? <Trans>You’re ready</Trans> : <Trans>Finish at your own pace</Trans>}
					</strong>
					<span data-flx="user.getting-started-tab.getting-started-tab.span--2">
						<Trans>You can reopen Getting Started from Settings at any time.</Trans>
					</span>
					{saveError ? (
						<span className={styles.error} role="alert" data-flx="user.getting-started-tab.getting-started-tab.error">
							{saveError}
						</span>
					) : null}
				</div>
				<div className={styles.footerActions} data-flx="user.getting-started-tab.getting-started-tab.footer-actions">
					<Button
						variant="ghost"
						disabled={saving}
						onClick={() => void handleDismiss()}
						data-flx="user.getting-started-tab.getting-started-tab.button--6"
					>
						<Trans>Not now</Trans>
					</Button>
					<Button
						variant="primary"
						disabled={!allComplete}
						submitting={saving}
						onClick={() => void handleFinish()}
						data-flx="user.getting-started-tab.getting-started-tab.button--7"
					>
						<Trans>Finish setup</Trans>
					</Button>
				</div>
			</div>
		</SettingsTabContainer>
	);
});

export default GettingStartedTab;
