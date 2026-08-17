// SPDX-License-Identifier: AGPL-3.0-or-later

import type {WindowsStartupMaintenanceTask} from '@electron/main/WindowsStartupMaintenancePolicy';

interface WorkerResult {
	ok: boolean;
	task: WindowsStartupMaintenanceTask;
	error?: string;
}

function taskFromArgv(): WindowsStartupMaintenanceTask | null {
	const task = process.argv[2];
	return task === 'vulkan' ? task : null;
}

function report(result: WorkerResult): void {
	process.parentPort?.postMessage(result);
}

async function run(): Promise<void> {
	const {initializeWindowsVulkanGameCaptureLayer} = await import('@electron/main/WindowsVulkanGameCaptureLayer');
	initializeWindowsVulkanGameCaptureLayer();
}

function exitAfterReport(code: number): void {
	setImmediate(() => process.exit(code));
}

const task = taskFromArgv();
if (!task) {
	console.error('[WindowsStartupMaintenanceWorker] Expected vulkan task');
	exitAfterReport(2);
} else {
	try {
		await run();
		report({ok: true, task});
		exitAfterReport(0);
	} catch (error) {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		console.error('[WindowsStartupMaintenanceWorker] Task failed', {task, error: message});
		report({ok: false, task, error: message});
		exitAfterReport(1);
	}
}
