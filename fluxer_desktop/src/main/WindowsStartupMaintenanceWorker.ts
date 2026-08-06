// SPDX-License-Identifier: AGPL-3.0-or-later

import type {WindowsStartupMaintenanceTask} from '@electron/main/WindowsStartupMaintenancePolicy';

interface WorkerResult {
	ok: boolean;
	task: WindowsStartupMaintenanceTask;
	error?: string;
}

function taskFromArgv(): WindowsStartupMaintenanceTask | null {
	const task = process.argv[2];
	return task === 'shortcuts' || task === 'vulkan' ? task : null;
}

function report(result: WorkerResult): void {
	process.parentPort?.postMessage(result);
}

async function run(task: WindowsStartupMaintenanceTask): Promise<void> {
	if (task === 'shortcuts') {
		const {repairWindowsShortcuts} = await import('@electron/main/WindowsShortcuts');
		await repairWindowsShortcuts();
		return;
	}
	const {initializeWindowsVulkanGameCaptureLayer} = await import('@electron/main/WindowsVulkanGameCaptureLayer');
	initializeWindowsVulkanGameCaptureLayer();
}

const task = taskFromArgv();
if (!task) {
	console.error('[WindowsStartupMaintenanceWorker] Expected shortcuts or vulkan task');
	process.exitCode = 2;
} else {
	try {
		await run(task);
		report({ok: true, task});
	} catch (error) {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		console.error('[WindowsStartupMaintenanceWorker] Task failed', {task, error: message});
		report({ok: false, task, error: message});
		process.exitCode = 1;
	}
}
