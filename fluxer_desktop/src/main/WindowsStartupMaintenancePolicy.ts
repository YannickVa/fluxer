// SPDX-License-Identifier: AGPL-3.0-or-later

export const WINDOWS_STARTUP_MAINTENANCE_TASKS = ['shortcuts', 'vulkan'] as const;

export type WindowsStartupMaintenanceTask = (typeof WINDOWS_STARTUP_MAINTENANCE_TASKS)[number];
export type WindowsStartupMaintenanceStatus = 'running' | 'succeeded' | 'failed';

export interface WindowsStartupMaintenanceTaskState {
	appVersion: string;
	status: WindowsStartupMaintenanceStatus;
	attemptedAt: string;
	completedAt?: string;
	exitCode?: number;
	reason?: string;
}

export interface WindowsStartupMaintenanceState {
	version: 1;
	tasks: Partial<Record<WindowsStartupMaintenanceTask, WindowsStartupMaintenanceTaskState>>;
}

export function emptyWindowsStartupMaintenanceState(): WindowsStartupMaintenanceState {
	return {version: 1, tasks: {}};
}

export function shouldRunWindowsStartupMaintenanceTask(
	state: WindowsStartupMaintenanceState,
	task: WindowsStartupMaintenanceTask,
	appVersion: string,
	forceRetry = false,
): boolean {
	if (forceRetry) return true;
	const previous = state.tasks[task];
	return previous?.appVersion !== appVersion;
}

export function withWindowsStartupMaintenanceTaskState(
	state: WindowsStartupMaintenanceState,
	task: WindowsStartupMaintenanceTask,
	taskState: WindowsStartupMaintenanceTaskState,
): WindowsStartupMaintenanceState {
	return {
		version: 1,
		tasks: {
			...state.tasks,
			[task]: taskState,
		},
	};
}
