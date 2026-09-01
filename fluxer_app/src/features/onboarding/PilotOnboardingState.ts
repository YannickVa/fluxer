// SPDX-License-Identifier: AGPL-3.0-or-later

import type {InstanceOnboarding, InstanceOnboardingSteps} from '@fluxer/instance_bootstrap/src/Types';

export type PilotOnboardingStepId = keyof InstanceOnboardingSteps;

export interface PilotOnboardingProgress {
	completedVersion: number;
	dismissedVersion: number;
	acknowledgedStepIds: ReadonlyArray<string>;
}

export const EMPTY_PILOT_ONBOARDING_PROGRESS: PilotOnboardingProgress = Object.freeze({
	completedVersion: 0,
	dismissedVersion: 0,
	acknowledgedStepIds: Object.freeze([]),
});

export function getEnabledPilotOnboardingSteps(config: InstanceOnboarding): Array<PilotOnboardingStepId> {
	return (Object.keys(config.steps) as Array<PilotOnboardingStepId>).filter((stepId) => config.steps[stepId]);
}

export function shouldAutoOpenPilotOnboarding(input: {
	config: InstanceOnboarding;
	progress: PilotOnboardingProgress;
	userCreatedAt: Date;
}): boolean {
	const {config, progress, userCreatedAt} = input;
	if (!config.enabled) return false;
	if (progress.completedVersion >= config.version || progress.dismissedVersion >= config.version) return false;
	if (config.show_for_existing_users) return true;
	if (!config.enabled_at) return false;

	const enabledAt = Date.parse(config.enabled_at);
	return Number.isFinite(enabledAt) && userCreatedAt.getTime() >= enabledAt;
}

export function acknowledgePilotOnboardingStep(
	progress: PilotOnboardingProgress,
	stepId: PilotOnboardingStepId,
): PilotOnboardingProgress {
	if (progress.acknowledgedStepIds.includes(stepId)) return progress;
	return {
		...progress,
		acknowledgedStepIds: [...progress.acknowledgedStepIds, stepId],
	};
}

export function completePilotOnboarding(progress: PilotOnboardingProgress, version: number): PilotOnboardingProgress {
	return {
		...progress,
		completedVersion: Math.max(progress.completedVersion, version),
	};
}

export function dismissPilotOnboarding(progress: PilotOnboardingProgress, version: number): PilotOnboardingProgress {
	return {
		...progress,
		dismissedVersion: Math.max(progress.dismissedVersion, version),
	};
}
