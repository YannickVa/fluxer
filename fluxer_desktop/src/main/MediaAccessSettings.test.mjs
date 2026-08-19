// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {transform} from 'esbuild';

const sourcePath = fileURLToPath(new URL('./MediaAccessSettings.ts', import.meta.url));
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-media-access-settings-'));
const compiledPath = path.join(temporaryDir, 'MediaAccessSettings.mjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = await transform(source, {format: 'esm', loader: 'ts', target: 'node24'});
fs.writeFileSync(compiledPath, compiled.code);

const {getMediaAccessSettingsUrl} = await import(pathToFileURL(compiledPath).href);

test.after(() => fs.rmSync(temporaryDir, {recursive: true, force: true}));

test('opens the Windows camera and microphone privacy pages', () => {
	assert.equal(getMediaAccessSettingsUrl('camera', 'win32'), 'ms-settings:privacy-webcam');
	assert.equal(getMediaAccessSettingsUrl('microphone', 'win32'), 'ms-settings:privacy-microphone');
	assert.equal(getMediaAccessSettingsUrl('screen', 'win32'), null);
});

test('keeps the macOS privacy settings routes intact', () => {
	assert.equal(
		getMediaAccessSettingsUrl('camera', 'darwin'),
		'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
	);
	assert.equal(
		getMediaAccessSettingsUrl('screen', 'darwin'),
		'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
	);
});

test('does not invent an OS settings route on unsupported platforms', () => {
	assert.equal(getMediaAccessSettingsUrl('camera', 'linux'), null);
});
