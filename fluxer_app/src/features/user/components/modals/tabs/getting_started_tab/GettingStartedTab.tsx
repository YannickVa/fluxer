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
import {ComponentDispatch} from '@app/features/platform/utils/ComponentBus';
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
			<span className={clsx(styles.statusPill, styles.statusComplete)}>
				<CheckCircleIcon size={remFromPx(14)} weight="fill" />
				<Trans>Ready</Trans>
			</span>
		);
	}
	if (status === 'skipped') {
		return (
			<span className={clsx(styles.statusPill, styles.statusSkipped)}>
				<CircleIcon size={remFromPx(14)} weight="fill" />
				<Trans>Do later</Trans>
			</span>
		);
	}
	return (
		<span className={clsx(styles.statusPill, styles.statusAttention)}>
			<Trans>Next step</Trans>
		</span>
	);
};

const StepRow: React.FC<StepRowProps> = ({icon, title, description, status, children}) => (
	<div className={styles.stepRow}>
		<div className={styles.stepIcon}>{icon}</div>
		<div className={styles.stepCopy}>
			<div className={styles.stepTitleRow}>
				<h3 className={styles.stepTitle}>{title}</h3>
				<StepStatusPill status={status} />
			</div>
			<p className={styles.stepDescription}>{description}</p>
		</div>
		<div className={styles.stepActions}>{children}</div>
	</div>
);

function getNotificationPermissionGranted(): boolean {
	return isDesktop() || (typeof Notification !== 'undefined' && Notification.permission === 'granted');
}

function getNotificationPreset(primaryGuildId: string | null): PilotNotificationPreset | null {
	if (!primaryGuildId) return null;
	return resolvePilotNotificationPreset({
		community: UserGuildSettings.getSettings(primaryGuildId).message_notifications,
		directMessages: UserGuildSettings.getSettings(null).message_notifications,
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
		ComponentDispatch.dispatch('USER_SETTINGS_TAB_SELECT', {tab, section});
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
		<SettingsTabContainer className={styles.container}>
			<div className={styles.hero}>
				<div className={styles.brandMark} aria-hidden="true">
					{RuntimeConfig.iconUrl ? (
						<img src={RuntimeConfig.iconUrl} alt="" />
					) : (
						<UsersThreeIcon size={remFromPx(30)} weight="duotone" />
					)}
				</div>
				<div className={styles.heroCopy}>
					<span className={styles.eyebrow}>
						<Trans>Private community setup</Trans>
					</span>
					<h2 className={styles.heroTitle}>
						<Trans>Welcome to {RuntimeConfig.productName}</Trans>
					</h2>
					<p className={styles.heroDescription}>
						{config.welcome_message ?? <Trans>Let’s make sure your account and this device are ready.</Trans>}
					</p>
					{config.operator_name || config.availability_message ? (
						<p className={styles.operatorLine}>
							{config.operator_name ? <Trans>Operated by {config.operator_name}.</Trans> : null}{' '}
							{config.availability_message}
						</p>
					) : null}
				</div>
				<div
					className={styles.progressPanel}
					role="status"
					aria-label={i18n._(msg`Setup progress: ${progressPercent}%`)}
				>
					<div className={styles.progressSummary}>
						<strong>
							{completedCount}/{enabledSteps.length}
						</strong>
						<span>
							<Trans>steps ready</Trans>
						</span>
					</div>
					<div className={styles.progressTrack} aria-hidden="true">
						<div className={styles.progressValue} style={{width: `${progressPercent}%`}} />
					</div>
				</div>
			</div>

			<SettingsSection id="getting-started-checklist" title={<Trans>Your setup checklist</Trans>}>
				<div className={styles.stepList}>
					{config.steps.profile ? (
						<StepRow
							icon={<IdentificationCardIcon size={ICON_SIZE} weight="duotone" />}
							title={<Trans>Complete your profile</Trans>}
							description={
								<Trans>
									Add a display name and avatar so friends can recognize you. Status and privacy choices remain
									optional.
								</Trans>
							}
							status={getStepStatus('profile')}
						>
							<Button
								small
								variant="secondary"
								onClick={() => openSettings('my_profile')}
								rightIcon={<ArrowRightIcon />}
							>
								<Trans>Open profile</Trans>
							</Button>
							{!actualCompletion.profile && !acknowledgedSteps.has('profile') ? (
								<Button small variant="ghost" onClick={() => void acknowledgeStep('profile')}>
									<Trans>Do later</Trans>
								</Button>
							) : null}
						</StepRow>
					) : null}

					{config.steps.security ? (
						<StepRow
							icon={<ShieldCheckIcon size={ICON_SIZE} weight="duotone" />}
							title={<Trans>Secure your account</Trans>}
							description={
								<Trans>Review your password, multi-factor authentication, recovery codes, and signed-in devices.</Trans>
							}
							status={getStepStatus('security')}
						>
							<Button
								small
								variant="secondary"
								onClick={() => openSettings('account_security', 'security')}
								rightIcon={<ArrowRightIcon />}
							>
								<Trans>Review security</Trans>
							</Button>
							{config.mfa_policy !== 'required' && !actualCompletion.security && !acknowledgedSteps.has('security') ? (
								<Button small variant="ghost" onClick={() => void acknowledgeStep('security')}>
									<Trans>Do later</Trans>
								</Button>
							) : null}
						</StepRow>
					) : null}

					{config.steps.notifications ? (
						<StepRow
							icon={<BellIcon size={ICON_SIZE} weight="duotone" />}
							title={<Trans>Test notifications</Trans>}
							description={
								<Trans>
									Choose a starting point, then test this device. You can fine-tune each community and channel later.
								</Trans>
							}
							status={getStepStatus('notifications')}
						>
							<div className={styles.presetGroup} role="group" aria-label={i18n._(msg`Notification preset`)}>
								<button
									type="button"
									className={clsx(
										styles.presetButton,
										notificationPreset === 'everything' && styles.presetButtonSelected,
									)}
									aria-pressed={notificationPreset === 'everything'}
									disabled={!primaryGuild}
									onClick={() => applyNotificationPreset('everything')}
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
								>
									<Trans>Mentions & DMs</Trans>
								</button>
								<button
									type="button"
									className={clsx(styles.presetButton, notificationPreset === 'quiet' && styles.presetButtonSelected)}
									aria-pressed={notificationPreset === 'quiet'}
									disabled={!primaryGuild}
									onClick={() => applyNotificationPreset('quiet')}
								>
									<Trans>Quiet</Trans>
								</button>
							</div>
							<Button small variant="secondary" onClick={() => void handleNotificationTest()}>
								<Trans>Allow & test</Trans>
							</Button>
							<Button small variant="ghost" onClick={() => openSettings('notifications')}>
								<Trans>Preferences</Trans>
							</Button>
							{!actualCompletion.notifications && !acknowledgedSteps.has('notifications') ? (
								<Button small variant="ghost" onClick={() => void acknowledgeStep('notifications')}>
									<Trans>Do later</Trans>
								</Button>
							) : null}
						</StepRow>
					) : null}

					{config.steps.media ? (
						<StepRow
							icon={<CameraIcon size={ICON_SIZE} weight="duotone" />}
							title={<Trans>Check voice & video</Trans>}
							description={
								<Trans>Confirm your microphone, speaker, and camera on this device. A camera is optional.</Trans>
							}
							status={getStepStatus('media')}
						>
							<Button
								small
								variant="secondary"
								onClick={() => openSettings('support_center', 'system-check')}
								rightIcon={<ArrowRightIcon />}
							>
								<Trans>Check my setup</Trans>
							</Button>
							{!actualCompletion.media ? (
								<Button small variant="ghost" onClick={() => updateDeviceState({mediaChecked: true})}>
									<Trans>I checked it</Trans>
								</Button>
							) : null}
						</StepRow>
					) : null}

					{config.steps.community ? (
						<StepRow
							icon={<UsersThreeIcon size={ICON_SIZE} weight="duotone" />}
							title={primaryGuild ? <Trans>Meet {primaryGuild.name}</Trans> : <Trans>Join the community</Trans>}
							description={
								<Trans>Read the welcome information and community rules, then find the important channels.</Trans>
							}
							status={getStepStatus('community')}
						>
							<Button
								small
								variant="secondary"
								disabled={!primaryGuild}
								onClick={() => openCommunityChannel(config.rules_channel_id ?? config.introduction_channel_id)}
								rightIcon={<ArrowRightIcon />}
							>
								<Trans>Open community</Trans>
							</Button>
							{!acknowledgedSteps.has('community') ? (
								<Button small variant="ghost" onClick={() => void acknowledgeStep('community')}>
									{primaryGuild ? <Trans>I’ve reviewed it</Trans> : <Trans>Do later</Trans>}
								</Button>
							) : null}
						</StepRow>
					) : null}
				</div>
			</SettingsSection>

			<div className={styles.footer}>
				<div className={styles.footerCopy}>
					<strong>{allComplete ? <Trans>You’re ready</Trans> : <Trans>Finish at your own pace</Trans>}</strong>
					<span>
						<Trans>You can reopen Getting Started from Settings at any time.</Trans>
					</span>
					{saveError ? (
						<span className={styles.error} role="alert">
							{saveError}
						</span>
					) : null}
				</div>
				<div className={styles.footerActions}>
					<Button variant="ghost" disabled={saving} onClick={() => void handleDismiss()}>
						<Trans>Not now</Trans>
					</Button>
					<Button variant="primary" disabled={!allComplete} submitting={saving} onClick={() => void handleFinish()}>
						<Trans>Finish setup</Trans>
					</Button>
				</div>
			</div>
		</SettingsTabContainer>
	);
});

export default GettingStartedTab;
