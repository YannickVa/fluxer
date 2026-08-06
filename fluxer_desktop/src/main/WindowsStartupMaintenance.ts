// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	emptyWindowsStartupMaintenanceState,
	shouldRunWindowsStartupMaintenanceTask,
	WINDOWS_STARTUP_MAINTENANCE_TASKS,
	type WindowsStartupMaintenanceState,
	type WindowsStartupMaintenanceTask,
	type WindowsStartupMaintenanceTaskState,
	withWindowsStartupMaintenanceTaskState,
} from '@electron/main/WindowsStartupMaintenancePolicy';
import {app, utilityProcess} from 'electron';
import log from 'electron-log';

const STATE_FILENAME = 'windows-startup-maintenance-v1.json';
const TASK_TIMEOUT_MS = 20_000;
const FORCE_RETRY_ENV = 'FLUXER_RETRY_WINDOWS_MAINTENANCE';

interface WorkerResult {
	ok: boolean;
	task: WindowsStartupMaintenanceTask;
	error?: string;
}

function statePath(): string {
	return path.join(app.getPath('userData'), STATE_FILENAME);
}

function readState(): WindowsStartupMaintenanceState {
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<WindowsStartupMaintenanceState>;
		if (parsed.version === 1 && parsed.tasks && typeof parsed.tasks === 'object') {
			return parsed as WindowsStartupMaintenanceState;
		}
	} catch {}
	return emptyWindowsStartupMaintenanceState();
}

function writeState(state: WindowsStartupMaintenanceState): void {
	const target = statePath();
	const temporary = `${target}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(path.dirname(target), {recursive: true});
		fs.writeFileSync(temporary, JSON.stringify(state), {encoding: 'utf8', mode: 0o600});
		fs.renameSync(temporary, target);
	} catch (error) {
		try {
			fs.rmSync(temporary, {force: true});
		} catch {}
		log.warn('[WindowsStartupMaintenance] Failed to persist task state', {error});
	}
}

function persistTaskState(task: WindowsStartupMaintenanceTask, taskState: WindowsStartupMaintenanceTaskState): void {
	writeState(withWindowsStartupMaintenanceTaskState(readState(), task, taskState));
}

function workerPath(): string {
	return fileURLToPath(new URL('./WindowsStartupMaintenanceWorker.js', import.meta.url));
}

function collectWorkerOutput(
	stream: NodeJS.ReadableStream | null,
	task: WindowsStartupMaintenanceTask,
	level: 'info' | 'warn',
) {
	stream?.setEncoding('utf8');
	stream?.on('data', (chunk: string) => {
		const output = chunk.trim();
		if (output) log[level]('[WindowsStartupMaintenance] Worker output', {task, output});
	});
}

async function runTask(task: WindowsStartupMaintenanceTask, appVersion: string): Promise<void> {
	const attemptedAt = new Date().toISOString();
	persistTaskState(task, {appVersion, status: 'running', attemptedAt});

	await new Promise<void>((resolve) => {
		let result: WorkerResult | null = null;
		let timedOut = false;
		let settled = false;
		let worker: Electron.UtilityProcess;
		try {
			worker = utilityProcess.fork(workerPath(), [task], {
				serviceName: `Fluxer Windows maintenance: ${task}`,
				stdio: 'pipe',
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			persistTaskState(task, {
				appVersion,
				status: 'failed',
				attemptedAt,
				completedAt: new Date().toISOString(),
				reason: `worker-start-failed: ${reason}`,
			});
			log.warn('[WindowsStartupMaintenance] Failed to start worker', {task, error});
			resolve();
			return;
		}
		collectWorkerOutput(worker.stdout, task, 'info');
		collectWorkerOutput(worker.stderr, task, 'warn');
		worker.on('message', (message: unknown) => {
			if (!message || typeof message !== 'object') return;
			const candidate = message as Partial<WorkerResult>;
			if (candidate.task !== task || typeof candidate.ok !== 'boolean') return;
			result = candidate as WorkerResult;
		});
		worker.on('error', (error) => {
			log.warn('[WindowsStartupMaintenance] Worker fatal error', {task, error});
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			worker.kill();
		}, TASK_TIMEOUT_MS);
		worker.on('exit', (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			const succeeded = !timedOut && exitCode === 0 && result?.ok === true;
			persistTaskState(task, {
				appVersion,
				status: succeeded ? 'succeeded' : 'failed',
				attemptedAt,
				completedAt: new Date().toISOString(),
				exitCode,
				...(!succeeded ? {reason: timedOut ? 'worker-timeout' : (result?.error ?? `worker-exit-${exitCode}`)} : {}),
			});
			if (succeeded) {
				log.info('[WindowsStartupMaintenance] Task completed', {task, appVersion});
			} else {
				log.warn('[WindowsStartupMaintenance] Task isolated after failure', {
					task,
					appVersion,
					exitCode,
					timedOut,
					error: result?.error,
				});
			}
			resolve();
		});
	});
}

export async function startWindowsStartupMaintenance(): Promise<void> {
	if (process.platform !== 'win32' || !app.isPackaged) return;
	const appVersion = app.getVersion();
	const forceRetry = process.env[FORCE_RETRY_ENV] === '1';
	for (const task of WINDOWS_STARTUP_MAINTENANCE_TASKS) {
		const state = readState();
		if (!shouldRunWindowsStartupMaintenanceTask(state, task, appVersion, forceRetry)) {
			log.info('[WindowsStartupMaintenance] Skipping previously attempted task', {
				task,
				appVersion,
				status: state.tasks[task]?.status,
			});
			continue;
		}
		await runTask(task, appVersion);
	}
}
