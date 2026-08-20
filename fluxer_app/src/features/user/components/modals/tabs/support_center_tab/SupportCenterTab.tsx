// SPDX-License-Identifier: AGPL-3.0-or-later

import {SettingsSection} from '@app/features/app/components/dialogs/shared/SettingsSection';
import {SettingsTabContainer} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import Config from '@app/features/app/config/Config';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import Updater from '@app/features/app/state/Updater';
import GatewayConnection from '@app/features/gateway/transport/GatewayConnection';
import MediaPermission from '@app/features/permissions/system/state/MediaPermission';
import {type ClientInfo, getClientInfo} from '@app/features/platform/utils/ClientInfo';
import {ComponentDispatch} from '@app/features/platform/utils/ComponentBus';
import {downloadTextFile} from '@app/features/platform/utils/DownloadFile';
import {
	createSupportDiagnosticsSnapshot,
	getOverallSupportStatus,
	getSafeOrigin,
	runEndpointHealthCheck,
	type SupportCheckStatus,
	type SupportDiagnosticsSnapshot,
	type SupportEndpointCheck,
	type SupportReadinessStep,
	serializeSupportDiagnostics,
} from '@app/features/support/SupportCenterDiagnostics';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {Button} from '@app/features/ui/button/Button';
import * as TextCopyCommands from '@app/features/ui/commands/TextCopyCommands';
import {isDesktop} from '@app/features/ui/utils/NativeUtils';
import MediaEngineFacade from '@app/features/voice/engine/MediaEngineFacade';
import {useMediaDevices} from '@app/features/voice/hooks/useMediaDevices';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {
	ArrowRightIcon,
	CameraIcon,
	CheckCircleIcon,
	ClipboardTextIcon,
	CloudCheckIcon,
	DownloadSimpleIcon,
	InfoIcon,
	MicrophoneIcon,
	MonitorIcon,
	PackageIcon,
	PathIcon,
	ProhibitIcon,
	SpinnerGapIcon,
	WarningCircleIcon,
	WifiHighIcon,
	WrenchIcon,
} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect, useMemo, useState} from 'react';
import styles from './SupportCenterTab.module.css';

const SUPPORT_SUMMARY_DESCRIPTOR = msg({
	message: 'Support summary copied',
	comment: 'Toast-like button state after the support summary is copied.',
});

const STATUS_ICON_SIZE = remFromPx(18);
const ACTION_ICON_SIZE = remFromPx(16);

interface StatusPresentation {
	label: React.ReactNode;
	icon: React.ReactNode;
}

function getStatusPresentation(status: SupportCheckStatus): StatusPresentation {
	switch (status) {
		case 'checking':
			return {
				label: <Trans>Checking</Trans>,
				icon: (
					<SpinnerGapIcon
						size={STATUS_ICON_SIZE}
						weight="bold"
						data-flx="user.support-center-tab.support-center-tab.get-status-presentation.spinner-gap-icon"
					/>
				),
			};
		case 'pass':
			return {
				label: <Trans>Ready</Trans>,
				icon: (
					<CheckCircleIcon
						size={STATUS_ICON_SIZE}
						weight="fill"
						data-flx="user.support-center-tab.support-center-tab.get-status-presentation.check-circle-icon"
					/>
				),
			};
		case 'warning':
			return {
				label: <Trans>Needs attention</Trans>,
				icon: (
					<WarningCircleIcon
						size={STATUS_ICON_SIZE}
						weight="fill"
						data-flx="user.support-center-tab.support-center-tab.get-status-presentation.warning-circle-icon"
					/>
				),
			};
		case 'fail':
			return {
				label: <Trans>Problem found</Trans>,
				icon: (
					<ProhibitIcon
						size={STATUS_ICON_SIZE}
						weight="fill"
						data-flx="user.support-center-tab.support-center-tab.get-status-presentation.prohibit-icon"
					/>
				),
			};
		case 'neutral':
			return {
				label: <Trans>Not required</Trans>,
				icon: (
					<InfoIcon
						size={STATUS_ICON_SIZE}
						weight="fill"
						data-flx="user.support-center-tab.support-center-tab.get-status-presentation.info-icon"
					/>
				),
			};
	}
}

const StatusPill: React.FC<{status: SupportCheckStatus}> = ({status}) => {
	const presentation = getStatusPresentation(status);
	return (
		<span
			className={clsx(styles.statusPill, styles[`status_${status}`])}
			data-flx="user.support-center-tab.support-center-tab.status-pill.status-pill"
		>
			{presentation.icon}
			<span data-flx="user.support-center-tab.support-center-tab.status-pill.span">{presentation.label}</span>
		</span>
	);
};

interface ReadinessRowProps {
	icon: React.ReactNode;
	title: React.ReactNode;
	description: React.ReactNode;
	status: SupportCheckStatus;
	action?: React.ReactNode;
}

const ReadinessRow: React.FC<ReadinessRowProps> = ({icon, title, description, status, action}) => (
	<div
		className={styles.readinessRow}
		data-flx="user.support-center-tab.support-center-tab.readiness-row.readiness-row"
	>
		<div
			className={styles.readinessIcon}
			data-flx="user.support-center-tab.support-center-tab.readiness-row.readiness-icon"
		>
			{icon}
		</div>
		<div
			className={styles.readinessCopy}
			data-flx="user.support-center-tab.support-center-tab.readiness-row.readiness-copy"
		>
			<div
				className={styles.readinessTitleRow}
				data-flx="user.support-center-tab.support-center-tab.readiness-row.readiness-title-row"
			>
				<h4
					className={styles.readinessTitle}
					data-flx="user.support-center-tab.support-center-tab.readiness-row.readiness-title"
				>
					{title}
				</h4>
				<StatusPill status={status} data-flx="user.support-center-tab.support-center-tab.readiness-row.status-pill" />
			</div>
			<p
				className={styles.readinessDescription}
				data-flx="user.support-center-tab.support-center-tab.readiness-row.readiness-description"
			>
				{description}
			</p>
		</div>
		{action ? (
			<div
				className={styles.readinessAction}
				data-flx="user.support-center-tab.support-center-tab.readiness-row.readiness-action"
			>
				{action}
			</div>
		) : null}
	</div>
);

interface QuickFixProps {
	icon: React.ReactNode;
	title: React.ReactNode;
	description: React.ReactNode;
	onClick: () => void;
}

const QuickFix: React.FC<QuickFixProps> = ({icon, title, description, onClick}) => (
	<button
		type="button"
		className={styles.quickFix}
		onClick={onClick}
		data-flx="user.support-center-tab.support-center-tab.quick-fix.quick-fix.click.button"
	>
		<span
			className={styles.quickFixIcon}
			data-flx="user.support-center-tab.support-center-tab.quick-fix.quick-fix-icon"
		>
			{icon}
		</span>
		<span
			className={styles.quickFixCopy}
			data-flx="user.support-center-tab.support-center-tab.quick-fix.quick-fix-copy"
		>
			<span
				className={styles.quickFixTitle}
				data-flx="user.support-center-tab.support-center-tab.quick-fix.quick-fix-title"
			>
				{title}
			</span>
			<span
				className={styles.quickFixDescription}
				data-flx="user.support-center-tab.support-center-tab.quick-fix.quick-fix-description"
			>
				{description}
			</span>
		</span>
		<ArrowRightIcon
			className={styles.quickFixArrow}
			size={ACTION_ICON_SIZE}
			weight="bold"
			data-flx="user.support-center-tab.support-center-tab.quick-fix.quick-fix-arrow"
		/>
	</button>
);

function endpointSummary(check: SupportEndpointCheck | undefined): string {
	if (!check) return 'waiting';
	if (check.status === 'pass') return `${check.durationMs ?? 0} ms`;
	if (check.error === 'timeout') return 'timed out';
	if (check.httpStatus) return `HTTP ${check.httpStatus}`;
	return 'unreachable';
}

function endpointSummaryNode(check: SupportEndpointCheck | undefined): React.ReactNode {
	if (!check) return <Trans>waiting</Trans>;
	if (check.status === 'pass') return <Trans>{check.durationMs ?? 0} ms</Trans>;
	if (check.error === 'timeout') return <Trans>timed out</Trans>;
	if (check.httpStatus) return <Trans>HTTP {check.httpStatus}</Trans>;
	return <Trans>unreachable</Trans>;
}

function getUpdateStatus(): SupportCheckStatus {
	if (Updater.isChecking) return 'checking';
	if (Updater.hasUpdate) return 'warning';
	if (Updater.nativeUnsupported) return 'neutral';
	return Updater.lastCheckedAt ? 'pass' : 'neutral';
}

function getDeviceStatus(inputCount: number, outputCount: number): SupportCheckStatus {
	if (MediaPermission.microphonePermissionState === 'denied') return 'fail';
	if (MediaPermission.cameraPermissionState === 'denied') return 'warning';
	if (inputCount === 0 || outputCount === 0) {
		return 'warning';
	}
	if (MediaPermission.microphonePermissionState !== 'granted' || MediaPermission.cameraPermissionState !== 'granted') {
		return 'neutral';
	}
	return 'pass';
}

function getGatewayStatus(): SupportCheckStatus {
	if (GatewayConnection.isReady && GatewayConnection.isConnected) return 'pass';
	if (GatewayConnection.isConnecting) return 'checking';
	return 'fail';
}

function formatPermission(value: PermissionState | null): string {
	switch (value) {
		case 'granted':
			return 'allowed';
		case 'denied':
			return 'blocked';
		case 'prompt':
			return 'not requested';
		default:
			return 'unknown';
	}
}

function permissionNode(value: PermissionState | null): React.ReactNode {
	switch (value) {
		case 'granted':
			return <Trans>allowed</Trans>;
		case 'denied':
			return <Trans>blocked</Trans>;
		case 'prompt':
			return <Trans>not requested</Trans>;
		default:
			return <Trans>unknown</Trans>;
	}
}

const SupportCenterTab: React.FC = observer(() => {
	const {i18n} = useLingui();
	const {inputDevices, outputDevices, videoDevices, refreshDevices} = useMediaDevices({requestPermissions: false});
	const [endpointChecks, setEndpointChecks] = useState<Array<SupportEndpointCheck>>([]);
	const [checksRunning, setChecksRunning] = useState(true);
	const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);
	const [diagnostics, setDiagnostics] = useState<SupportDiagnosticsSnapshot | null>(null);
	const [summaryCopied, setSummaryCopied] = useState(false);

	const runChecks = useCallback(async () => {
		setChecksRunning(true);
		setDiagnostics(null);
		const checks = [
			runEndpointHealthCheck('app', RuntimeConfig.webAppBaseUrl),
			runEndpointHealthCheck('api', RuntimeConfig.apiEndpoint),
		];
		if (RuntimeConfig.features.voice_enabled && RuntimeConfig.mediaEndpoint) {
			checks.push(runEndpointHealthCheck('media', RuntimeConfig.mediaEndpoint));
		}
		const [nextChecks, nextClientInfo] = await Promise.all([
			Promise.all(checks),
			getClientInfo(),
			refreshDevices({requestPermissions: false, forceRefresh: true}).then(
				() => null,
				() => null,
			),
		]).then(([healthChecks, info]) => [healthChecks, info] as const);
		setEndpointChecks(nextChecks);
		setClientInfo(nextClientInfo);
		setChecksRunning(false);
	}, [refreshDevices]);

	useEffect(() => {
		void runChecks();
	}, [runChecks]);

	const appCheck = endpointChecks.find((check) => check.service === 'app');
	const apiCheck = endpointChecks.find((check) => check.service === 'api');
	const mediaCheck = endpointChecks.find((check) => check.service === 'media');
	const instanceStatus: SupportCheckStatus = checksRunning
		? 'checking'
		: appCheck?.status === 'pass' && apiCheck?.status === 'pass'
			? 'pass'
			: 'fail';
	const gatewayStatus = getGatewayStatus();
	const voiceStatus: SupportCheckStatus = !RuntimeConfig.features.voice_enabled
		? 'neutral'
		: checksRunning
			? 'checking'
			: mediaCheck?.status === 'pass'
				? 'pass'
				: 'fail';
	const deviceStatus = getDeviceStatus(inputDevices.length, outputDevices.length);
	const updateStatus = getUpdateStatus();
	const lastUpdateCheck = Updater.lastCheckedAt
		? new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(Updater.lastCheckedAt)
		: null;
	const readinessSteps: Array<SupportReadinessStep> = [
		{id: 'instance', status: instanceStatus},
		{id: 'messaging', status: gatewayStatus},
		{id: 'voice', status: voiceStatus},
		{id: 'devices', status: deviceStatus},
		{id: 'update', status: updateStatus},
	];
	const overallStatus = getOverallSupportStatus(readinessSteps);
	const overallPresentation = getStatusPresentation(overallStatus);

	const openSettings = useCallback((tab: string, section?: string) => {
		ComponentDispatch.dispatch('USER_SETTINGS_TAB_SELECT', {tab, section});
	}, []);

	const createDiagnostics = useCallback((): SupportDiagnosticsSnapshot => {
		const info = clientInfo ?? {};
		const snapshot = createSupportDiagnosticsSnapshot({
			product: {
				name: RuntimeConfig.productName,
				instanceOrigin: getSafeOrigin(RuntimeConfig.webAppBaseUrl || RuntimeConfig.apiEndpoint),
				selfHosted: RuntimeConfig.isSelfHosted(),
				voiceEnabled: RuntimeConfig.features.voice_enabled,
			},
			build: {
				webVersion: Config.PUBLIC_BUILD_VERSION || 'dev',
				releaseChannel: Config.PUBLIC_RELEASE_CHANNEL,
				desktopVersion: info.desktopVersion ?? null,
				desktopChannel: info.desktopChannel ?? null,
			},
			client: {
				os: info.osName ?? null,
				osVersion: info.osVersion ?? null,
				architecture: info.desktopArch ?? info.arch ?? null,
				browser: info.browserName ?? null,
				browserVersion: info.browserVersion ?? null,
				desktop: isDesktop(),
			},
			connectivity: {
				browserOnline: navigator.onLine,
				gateway:
					GatewayConnection.isReady && GatewayConnection.isConnected
						? 'ready'
						: GatewayConnection.isConnecting
							? 'connecting'
							: 'disconnected',
				checks: endpointChecks,
			},
			media: {
				microphonePermission: MediaPermission.microphonePermissionState ?? 'unknown',
				cameraPermission: MediaPermission.cameraPermissionState ?? 'unknown',
				inputDeviceCount: inputDevices.length,
				outputDeviceCount: outputDevices.length,
				cameraDeviceCount: videoDevices.length,
				voiceSession: MediaEngineFacade.connected
					? 'connected'
					: MediaEngineFacade.reconnecting
						? 'reconnecting'
						: MediaEngineFacade.connecting
							? 'connecting'
							: 'not-connected',
				connectionQuality: MediaEngineFacade.connected ? String(MediaEngineFacade.localConnectionQuality) : null,
				latencyMs: MediaEngineFacade.connected ? MediaEngineFacade.currentLatency : null,
			},
			update: {
				state: Updater.state,
				currentVersion: Updater.currentVersion ?? Config.PUBLIC_BUILD_VERSION ?? null,
				availableVersion: Updater.displayVersion,
				channel: Updater.channel ?? Config.PUBLIC_RELEASE_CHANNEL,
				lastCheckedAt: Updater.lastCheckedAt ? new Date(Updater.lastCheckedAt).toISOString() : null,
				updateAvailable: Updater.hasUpdate,
				downloadReady: Updater.nativeUpdateReady,
				unsupportedReason: Updater.nativeUnsupported?.reason ?? null,
			},
		});
		setDiagnostics(snapshot);
		return snapshot;
	}, [clientInfo, endpointChecks, inputDevices.length, outputDevices.length, videoDevices.length]);

	const diagnosticsJson = useMemo(() => (diagnostics ? serializeSupportDiagnostics(diagnostics) : null), [diagnostics]);

	const copySummary = useCallback(async () => {
		const info = clientInfo ?? {};
		const summary = [
			`${RuntimeConfig.productName} support summary`,
			`Overall: ${overallStatus}`,
			`Instance: ${getSafeOrigin(RuntimeConfig.webAppBaseUrl || RuntimeConfig.apiEndpoint)}`,
			`Web build: ${Config.PUBLIC_BUILD_VERSION || 'dev'} (${Config.PUBLIC_RELEASE_CHANNEL})`,
			info.desktopVersion
				? `Desktop: ${info.desktopVersion} (${info.desktopChannel ?? 'unknown channel'})`
				: 'Desktop: no',
			`System: ${[info.osName, info.osVersion, info.desktopArch ?? info.arch].filter(Boolean).join(' ') || 'unknown'}`,
			`Checks: app ${endpointSummary(appCheck)}, API ${endpointSummary(apiCheck)}, media ${RuntimeConfig.features.voice_enabled ? endpointSummary(mediaCheck) : 'disabled'}`,
			`Messaging: ${gatewayStatus}`,
			`Devices: ${inputDevices.length} microphone(s), ${outputDevices.length} speaker(s), ${videoDevices.length} camera(s)`,
			`Permissions: microphone ${formatPermission(MediaPermission.microphonePermissionState)}, camera ${formatPermission(MediaPermission.cameraPermissionState)}`,
			`Update: ${Updater.hasUpdate ? `available (${Updater.displayVersion ?? 'version unknown'})` : updateStatus}`,
		].join('\n');
		if (await TextCopyCommands.copy(i18n, summary, true)) {
			setSummaryCopied(true);
			window.setTimeout(() => setSummaryCopied(false), 1800);
		}
	}, [
		appCheck,
		apiCheck,
		clientInfo,
		gatewayStatus,
		i18n,
		inputDevices.length,
		mediaCheck,
		outputDevices.length,
		overallStatus,
		updateStatus,
		videoDevices.length,
	]);

	const downloadDiagnostics = useCallback(() => {
		const snapshot = diagnostics ?? createDiagnostics();
		const timestamp = snapshot.generatedAt.replace(/[:.]/g, '-');
		downloadTextFile(
			serializeSupportDiagnostics(snapshot),
			`fluxer-support-${timestamp}.json`,
			'application/json;charset=utf-8',
		);
	}, [createDiagnostics, diagnostics]);

	return (
		<SettingsTabContainer className={styles.container} data-flx="user.support-center-tab.support-center-tab.container">
			<section
				className={styles.hero}
				aria-labelledby="support-center-title"
				data-flx="user.support-center-tab.support-center-tab.hero"
			>
				<div className={styles.heroCopy} data-flx="user.support-center-tab.support-center-tab.hero-copy">
					<span className={styles.eyebrow} data-flx="user.support-center-tab.support-center-tab.eyebrow">
						<WrenchIcon
							size={ACTION_ICON_SIZE}
							weight="bold"
							data-flx="user.support-center-tab.support-center-tab.wrench-icon"
						/>{' '}
						<Trans>Support center</Trans>
					</span>
					<h2
						id="support-center-title"
						className={styles.heroTitle}
						data-flx="user.support-center-tab.support-center-tab.support-center-title"
					>
						<Trans>Let's get everything working</Trans>
					</h2>
					<p className={styles.heroDescription} data-flx="user.support-center-tab.support-center-tab.hero-description">
						<Trans>Check your connection, devices, app version, and the services this client depends on.</Trans>
					</p>
				</div>
				<div className={styles.heroStatus} data-flx="user.support-center-tab.support-center-tab.hero-status">
					<div
						className={clsx(styles.overallIcon, styles[`overall_${overallStatus}`])}
						data-flx="user.support-center-tab.support-center-tab.overall-icon"
					>
						{overallPresentation.icon}
					</div>
					<div data-flx="user.support-center-tab.support-center-tab.div">
						<span className={styles.overallLabel} data-flx="user.support-center-tab.support-center-tab.overall-label">
							{overallPresentation.label}
						</span>
						<span className={styles.overallHint} data-flx="user.support-center-tab.support-center-tab.overall-hint">
							{overallStatus === 'pass' ? <Trans>All checked systems look healthy.</Trans> : null}
							{overallStatus === 'warning' ? <Trans>One or more items may need your attention.</Trans> : null}
							{overallStatus === 'fail' ? (
								<Trans>We found something that may stop the app working correctly.</Trans>
							) : null}
							{overallStatus === 'checking' ? <Trans>Running a fresh check now.</Trans> : null}
							{overallStatus === 'neutral' ? <Trans>Run a check to see your setup status.</Trans> : null}
						</span>
					</div>
				</div>
			</section>

			<SettingsSection
				id="system-check"
				title={<Trans>Check my setup</Trans>}
				description={<Trans>A live path through the systems needed for chat, calls, and updates.</Trans>}
				actions={
					<Button
						variant="secondary"
						small
						submitting={checksRunning}
						onClick={() => void runChecks()}
						leftIcon={
							<PathIcon size={ACTION_ICON_SIZE} data-flx="user.support-center-tab.support-center-tab.path-icon" />
						}
						data-flx="user.support-center-tab.support-center-tab.button"
					>
						<Trans>Run again</Trans>
					</Button>
				}
				data-flx="user.support-center-tab.support-center-tab.system-check"
			>
				<div className={styles.readinessList} data-flx="user.support-center-tab.support-center-tab.readiness-list">
					<ReadinessRow
						icon={
							<CloudCheckIcon
								size={remFromPx(22)}
								weight="duotone"
								data-flx="user.support-center-tab.support-center-tab.cloud-check-icon"
							/>
						}
						title={<Trans>Instance</Trans>}
						description={
							<Trans>
								App {endpointSummaryNode(appCheck)} · API {endpointSummaryNode(apiCheck)}
							</Trans>
						}
						status={instanceStatus}
						data-flx="user.support-center-tab.support-center-tab.readiness-row"
					/>
					<ReadinessRow
						icon={
							<WifiHighIcon
								size={remFromPx(22)}
								weight="duotone"
								data-flx="user.support-center-tab.support-center-tab.wifi-high-icon"
							/>
						}
						title={<Trans>Messaging</Trans>}
						description={
							GatewayConnection.isReady ? (
								<Trans>Live message connection is ready.</Trans>
							) : (
								<Trans>The live message connection is not ready.</Trans>
							)
						}
						status={gatewayStatus}
						data-flx="user.support-center-tab.support-center-tab.readiness-row--2"
					/>
					<ReadinessRow
						icon={
							<MicrophoneIcon
								size={remFromPx(22)}
								weight="duotone"
								data-flx="user.support-center-tab.support-center-tab.microphone-icon"
							/>
						}
						title={<Trans>Voice service</Trans>}
						description={
							!RuntimeConfig.features.voice_enabled ? (
								<Trans>Voice is disabled on this instance.</Trans>
							) : (
								<>
									<Trans>Media service {endpointSummaryNode(mediaCheck)}.</Trans>{' '}
									{MediaEngineFacade.connected ? (
										<Trans>You are connected to a call.</Trans>
									) : (
										<Trans>No call is active right now.</Trans>
									)}
								</>
							)
						}
						status={voiceStatus}
						action={
							<Button
								variant="ghost"
								small
								onClick={() => openSettings('voice_video', 'audio')}
								data-flx="user.support-center-tab.support-center-tab.button.open-settings"
							>
								<Trans>Test audio</Trans>
							</Button>
						}
						data-flx="user.support-center-tab.support-center-tab.readiness-row--3"
					/>
					<ReadinessRow
						icon={
							<CameraIcon
								size={remFromPx(22)}
								weight="duotone"
								data-flx="user.support-center-tab.support-center-tab.camera-icon"
							/>
						}
						title={<Trans>Devices & permissions</Trans>}
						description={
							<Trans>
								{inputDevices.length} microphone(s), {outputDevices.length} speaker(s), {videoDevices.length} camera(s).
								Microphone {permissionNode(MediaPermission.microphonePermissionState)}; camera{' '}
								{permissionNode(MediaPermission.cameraPermissionState)}.
							</Trans>
						}
						status={deviceStatus}
						action={
							<Button
								variant="ghost"
								small
								onClick={() => openSettings('voice_video', 'video')}
								data-flx="user.support-center-tab.support-center-tab.button.open-settings--2"
							>
								<Trans>Test camera</Trans>
							</Button>
						}
						data-flx="user.support-center-tab.support-center-tab.readiness-row--4"
					/>
					<ReadinessRow
						icon={
							<PackageIcon
								size={remFromPx(22)}
								weight="duotone"
								data-flx="user.support-center-tab.support-center-tab.package-icon"
							/>
						}
						title={<Trans>Updates</Trans>}
						description={
							Updater.hasUpdate ? (
								<Trans>Version {Updater.displayVersion ?? 'unknown'} is available.</Trans>
							) : lastUpdateCheck ? (
								<Trans>Last checked: {lastUpdateCheck}</Trans>
							) : (
								<Trans>Not checked yet.</Trans>
							)
						}
						status={updateStatus}
						action={
							<Button
								variant="ghost"
								small
								submitting={Updater.isChecking}
								onClick={() => void Updater.checkForUpdates(true, true)}
								data-flx="user.support-center-tab.support-center-tab.button--2"
							>
								<Trans>Check now</Trans>
							</Button>
						}
						data-flx="user.support-center-tab.support-center-tab.readiness-row--5"
					/>
				</div>
			</SettingsSection>

			<SettingsSection
				id="common-fixes"
				title={<Trans>Fix a common problem</Trans>}
				description={<Trans>Go straight to the settings and tests that can resolve it.</Trans>}
				data-flx="user.support-center-tab.support-center-tab.common-fixes"
			>
				<div className={styles.quickFixGrid} data-flx="user.support-center-tab.support-center-tab.quick-fix-grid">
					<QuickFix
						icon={
							<MicrophoneIcon
								size={remFromPx(20)}
								data-flx="user.support-center-tab.support-center-tab.microphone-icon--2"
							/>
						}
						title={<Trans>I can't hear or be heard</Trans>}
						description={<Trans>Choose devices, check levels, and test your microphone.</Trans>}
						onClick={() => openSettings('voice_video', 'audio')}
						data-flx="user.support-center-tab.support-center-tab.quick-fix.open-settings"
					/>
					<QuickFix
						icon={
							<CameraIcon size={remFromPx(20)} data-flx="user.support-center-tab.support-center-tab.camera-icon--2" />
						}
						title={<Trans>My camera isn't working</Trans>}
						description={<Trans>Check permission, preview video, and select a camera.</Trans>}
						onClick={() => openSettings('voice_video', 'video')}
						data-flx="user.support-center-tab.support-center-tab.quick-fix.open-settings--2"
					/>
					<QuickFix
						icon={
							<MonitorIcon size={remFromPx(20)} data-flx="user.support-center-tab.support-center-tab.monitor-icon" />
						}
						title={<Trans>The app looks or feels wrong</Trans>}
						description={<Trans>Review display, motion, accessibility, and performance settings.</Trans>}
						onClick={() => openSettings('appearance')}
						data-flx="user.support-center-tab.support-center-tab.quick-fix.open-settings--3"
					/>
					<QuickFix
						icon={
							<WarningCircleIcon
								size={remFromPx(20)}
								data-flx="user.support-center-tab.support-center-tab.warning-circle-icon"
							/>
						}
						title={<Trans>Notifications are missing</Trans>}
						description={<Trans>Review desktop, push, sound, and mention settings.</Trans>}
						onClick={() => openSettings('notifications')}
						data-flx="user.support-center-tab.support-center-tab.quick-fix.open-settings--4"
					/>
				</div>
			</SettingsSection>

			<SettingsSection
				id="version-updates"
				title={<Trans>Version & updates</Trans>}
				description={<Trans>Release identity helps support confirm exactly which client you are using.</Trans>}
				data-flx="user.support-center-tab.support-center-tab.version-updates"
			>
				<div className={styles.identityPanel} data-flx="user.support-center-tab.support-center-tab.identity-panel">
					<div className={styles.identityGrid} data-flx="user.support-center-tab.support-center-tab.identity-grid">
						<div data-flx="user.support-center-tab.support-center-tab.div--2">
							<span
								className={styles.identityLabel}
								data-flx="user.support-center-tab.support-center-tab.identity-label"
							>
								<Trans>Instance</Trans>
							</span>
							<span
								className={styles.identityValue}
								data-flx="user.support-center-tab.support-center-tab.identity-value"
							>
								{getSafeOrigin(RuntimeConfig.webAppBaseUrl || RuntimeConfig.apiEndpoint)}
							</span>
						</div>
						<div data-flx="user.support-center-tab.support-center-tab.div--3">
							<span
								className={styles.identityLabel}
								data-flx="user.support-center-tab.support-center-tab.identity-label--2"
							>
								<Trans>Web build</Trans>
							</span>
							<span
								className={styles.identityValue}
								data-flx="user.support-center-tab.support-center-tab.identity-value--2"
							>
								{Config.PUBLIC_BUILD_VERSION || 'dev'}
							</span>
						</div>
						<div data-flx="user.support-center-tab.support-center-tab.div--4">
							<span
								className={styles.identityLabel}
								data-flx="user.support-center-tab.support-center-tab.identity-label--3"
							>
								<Trans>Release channel</Trans>
							</span>
							<span
								className={styles.identityValue}
								data-flx="user.support-center-tab.support-center-tab.identity-value--3"
							>
								{Config.PUBLIC_RELEASE_CHANNEL}
							</span>
						</div>
						<div data-flx="user.support-center-tab.support-center-tab.div--5">
							<span
								className={styles.identityLabel}
								data-flx="user.support-center-tab.support-center-tab.identity-label--4"
							>
								<Trans>Desktop build</Trans>
							</span>
							<span
								className={styles.identityValue}
								data-flx="user.support-center-tab.support-center-tab.identity-value--4"
							>
								{clientInfo?.desktopVersion ?? <Trans>Browser</Trans>}
							</span>
						</div>
						<div data-flx="user.support-center-tab.support-center-tab.div--6">
							<span
								className={styles.identityLabel}
								data-flx="user.support-center-tab.support-center-tab.identity-label--5"
							>
								<Trans>System</Trans>
							</span>
							<span
								className={styles.identityValue}
								data-flx="user.support-center-tab.support-center-tab.identity-value--5"
							>
								{[clientInfo?.osName, clientInfo?.osVersion, clientInfo?.desktopArch ?? clientInfo?.arch]
									.filter(Boolean)
									.join(' ') || <Trans>Detecting…</Trans>}
							</span>
						</div>
						<div data-flx="user.support-center-tab.support-center-tab.div--7">
							<span
								className={styles.identityLabel}
								data-flx="user.support-center-tab.support-center-tab.identity-label--6"
							>
								<Trans>Update status</Trans>
							</span>
							<span
								className={styles.identityValue}
								data-flx="user.support-center-tab.support-center-tab.identity-value--6"
							>
								{Updater.hasUpdate ? <Trans>Update available</Trans> : <Trans>No update found</Trans>}
							</span>
						</div>
					</div>
					<div className={styles.buttonRow} data-flx="user.support-center-tab.support-center-tab.button-row">
						<Button
							variant="secondary"
							small
							submitting={Updater.isChecking}
							onClick={() => void Updater.checkForUpdates(true, true)}
							leftIcon={
								<PackageIcon
									size={ACTION_ICON_SIZE}
									data-flx="user.support-center-tab.support-center-tab.package-icon--2"
								/>
							}
							data-flx="user.support-center-tab.support-center-tab.button--3"
						>
							<Trans>Check for updates</Trans>
						</Button>
						{Updater.hasUpdate ? (
							<Button
								small
								onClick={() => void Updater.applyUpdate()}
								data-flx="user.support-center-tab.support-center-tab.button--4"
							>
								<Trans>Update</Trans>
							</Button>
						) : null}
					</div>
				</div>
			</SettingsSection>

			<SettingsSection
				id="diagnostics"
				title={<Trans>Diagnostics to share</Trans>}
				description={<Trans>Create a small, privacy-reviewed snapshot for someone helping you troubleshoot.</Trans>}
				data-flx="user.support-center-tab.support-center-tab.diagnostics"
			>
				<div
					className={styles.diagnosticsPanel}
					data-flx="user.support-center-tab.support-center-tab.diagnostics-panel"
				>
					<div className={styles.privacyNote} data-flx="user.support-center-tab.support-center-tab.privacy-note">
						<InfoIcon
							size={remFromPx(20)}
							weight="fill"
							data-flx="user.support-center-tab.support-center-tab.info-icon"
						/>
						<div data-flx="user.support-center-tab.support-center-tab.div--8">
							<strong data-flx="user.support-center-tab.support-center-tab.strong">
								<Trans>You stay in control</Trans>
							</strong>
							<p data-flx="user.support-center-tab.support-center-tab.p">
								<Trans>
									The file includes versions, operating system, service-check results, permission states, and device
									counts. It does not include passwords, tokens, cookies, messages, attachments, account IDs, community
									or channel names, participant identities, device IDs, or raw server responses.
								</Trans>
							</p>
						</div>
					</div>
					<div className={styles.buttonRow} data-flx="user.support-center-tab.support-center-tab.button-row--2">
						<Button
							variant="secondary"
							small
							disabled={checksRunning}
							onClick={() => void copySummary()}
							leftIcon={
								<ClipboardTextIcon
									size={ACTION_ICON_SIZE}
									data-flx="user.support-center-tab.support-center-tab.clipboard-text-icon"
								/>
							}
							data-flx="user.support-center-tab.support-center-tab.button--5"
						>
							{summaryCopied ? i18n._(SUPPORT_SUMMARY_DESCRIPTOR) : <Trans>Copy support summary</Trans>}
						</Button>
						<Button
							variant="secondary"
							small
							disabled={checksRunning}
							onClick={createDiagnostics}
							leftIcon={
								<InfoIcon size={ACTION_ICON_SIZE} data-flx="user.support-center-tab.support-center-tab.info-icon--2" />
							}
							data-flx="user.support-center-tab.support-center-tab.button.create-diagnostics"
						>
							<Trans>Preview diagnostics</Trans>
						</Button>
						<Button
							small
							disabled={checksRunning}
							onClick={downloadDiagnostics}
							leftIcon={
								<DownloadSimpleIcon
									size={ACTION_ICON_SIZE}
									data-flx="user.support-center-tab.support-center-tab.download-simple-icon"
								/>
							}
							data-flx="user.support-center-tab.support-center-tab.button.download-diagnostics"
						>
							<Trans>Download diagnostics</Trans>
						</Button>
					</div>
					{diagnosticsJson ? (
						<details className={styles.preview} open data-flx="user.support-center-tab.support-center-tab.preview">
							<summary data-flx="user.support-center-tab.support-center-tab.summary">
								<Trans>Exact contents of the diagnostic file</Trans>
							</summary>
							<pre data-flx="user.support-center-tab.support-center-tab.pre">{diagnosticsJson}</pre>
						</details>
					) : null}
				</div>
			</SettingsSection>
		</SettingsTabContainer>
	);
});

export default SupportCenterTab;
