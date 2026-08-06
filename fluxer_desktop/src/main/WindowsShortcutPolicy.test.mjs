// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {transform} from 'esbuild';

const sourcePath = fileURLToPath(new URL('./WindowsShortcutPolicy.ts', import.meta.url));
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-shortcut-policy-'));
const compiledPath = path.join(temporaryDir, 'WindowsShortcutPolicy.mjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = await transform(source, {format: 'esm', loader: 'ts', target: 'node24'});
fs.writeFileSync(compiledPath, compiled.code);

const {shouldRepairWindowsShortcut} = await import(pathToFileURL(compiledPath).href);

test.after(() => fs.rmSync(temporaryDir, {recursive: true, force: true}));

const root = 'C:\\Users\\Yannick\\AppData\\Local\\fluxer_desktop_canary';
const current = `${root}\\current\\Fluxer Canary.exe`;
const legacy = ['com.fluxer.desktop'];

test('leaves a current shortcut with the current identity unchanged', () => {
	assert.equal(shouldRepairWindowsShortcut({target: current, appUserModelId: 'com.matskos.fluxer'}, current, root, legacy), false);
});

test('repairs an older executable under the same installation root', () => {
	assert.equal(
		shouldRepairWindowsShortcut({target: `${root}\\app-2026.1\\Fluxer Canary.exe`}, current, root, legacy),
		true,
	);
});

test('repairs an installer shortcut accidentally written for another user profile', () => {
	assert.equal(
		shouldRepairWindowsShortcut(
			{
				target:
					'C:\\Users\\CodexSandboxOffline\\AppData\\Local\\fluxer_desktop_canary\\current\\Fluxer Canary.exe',
			},
			current,
			root,
			legacy,
		),
		true,
	);
});

test('repairs a shortcut carrying a legacy application identity', () => {
	assert.equal(shouldRepairWindowsShortcut({target: current, appUserModelId: 'COM.FLUXER.DESKTOP'}, current, root, legacy), true);
});

test('never rewrites an unrelated shortcut', () => {
	assert.equal(
		shouldRepairWindowsShortcut(
			{target: 'C:\\Program Files\\Unrelated\\Unrelated.exe', appUserModelId: 'com.fluxer.desktop'},
			current,
			root,
			legacy,
		),
		false,
	);
});
