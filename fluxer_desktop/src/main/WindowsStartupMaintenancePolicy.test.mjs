// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const sourcePath = fileURLToPath(new URL('./WindowsStartupMaintenancePolicy.ts', import.meta.url));
const transformedSource = esbuild.transformSync(readFileSync(sourcePath, 'utf8'), {
	loader: 'ts',
	format: 'cjs',
	platform: 'node',
	target: 'node20',
}).code;
const module = {exports: {}};
vm.runInNewContext(transformedSource, {module, exports: module.exports}, {filename: sourcePath});

const {
	emptyWindowsStartupMaintenanceState,
	shouldRunWindowsStartupMaintenanceTask,
	withWindowsStartupMaintenanceTaskState,
} = module.exports;

describe('Windows startup maintenance policy', () => {
	test('runs a task when no state exists', () => {
		const state = emptyWindowsStartupMaintenanceState();
		assert.equal(shouldRunWindowsStartupMaintenanceTask(state, 'shortcuts', '1.2.3'), true);
	});

	test('does not repeat success for the same app version', () => {
		const state = withWindowsStartupMaintenanceTaskState(emptyWindowsStartupMaintenanceState(), 'shortcuts', {
			appVersion: '1.2.3',
			status: 'succeeded',
			attemptedAt: '2026-08-06T00:00:00.000Z',
			completedAt: '2026-08-06T00:00:01.000Z',
		});
		assert.equal(shouldRunWindowsStartupMaintenanceTask(state, 'shortcuts', '1.2.3'), false);
	});

	test('does not retry a crashed or interrupted task for the same app version', () => {
		for (const status of ['running', 'failed']) {
			const state = withWindowsStartupMaintenanceTaskState(emptyWindowsStartupMaintenanceState(), 'vulkan', {
				appVersion: '1.2.3',
				status,
				attemptedAt: '2026-08-06T00:00:00.000Z',
			});
			assert.equal(shouldRunWindowsStartupMaintenanceTask(state, 'vulkan', '1.2.3'), false);
		}
	});

	test('runs again after an application update', () => {
		const state = withWindowsStartupMaintenanceTaskState(emptyWindowsStartupMaintenanceState(), 'shortcuts', {
			appVersion: '1.2.3',
			status: 'failed',
			attemptedAt: '2026-08-06T00:00:00.000Z',
		});
		assert.equal(shouldRunWindowsStartupMaintenanceTask(state, 'shortcuts', '1.2.4'), true);
	});

	test('explicit retry overrides same-version suppression', () => {
		const state = withWindowsStartupMaintenanceTaskState(emptyWindowsStartupMaintenanceState(), 'shortcuts', {
			appVersion: '1.2.3',
			status: 'failed',
			attemptedAt: '2026-08-06T00:00:00.000Z',
		});
		assert.equal(shouldRunWindowsStartupMaintenanceTask(state, 'shortcuts', '1.2.3', true), true);
	});
});
