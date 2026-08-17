// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {transform} from 'esbuild';

const sourcePath = fileURLToPath(new URL('./DesktopUpdateEndpoints.ts', import.meta.url));
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-update-endpoints-'));
const compiledPath = path.join(temporaryDir, 'DesktopUpdateEndpoints.mjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = await transform(source, {format: 'esm', loader: 'ts', target: 'node24'});
fs.writeFileSync(compiledPath, compiled.code);

const {resolveDesktopUpdateEndpoints} = await import(pathToFileURL(compiledPath).href);

test.after(() => fs.rmSync(temporaryDir, {recursive: true, force: true}));

test('retains official channel defaults without overrides', () => {
	assert.deepEqual(
		resolveDesktopUpdateEndpoints({
			channel: 'canary',
			platform: 'win32',
			arch: 'x64',
		}),
		{
			updateBaseUrl: 'https://api.canary.fluxer.app/dl/desktop/canary/win32/x64',
			downloadPageUrl: 'https://canary.fluxer.app/download',
		},
	);
});

test('uses normalized Matskos release URLs when embedded by the build', () => {
	assert.deepEqual(
		resolveDesktopUpdateEndpoints({
			channel: 'canary',
			platform: 'win32',
			arch: 'x64',
			updateBaseUrlOverride: ' https://github.com/YannickVa/fluxer/releases/latest/download/ ',
			downloadPageUrlOverride: 'https://github.com/YannickVa/fluxer/releases/latest/',
		}),
		{
			updateBaseUrl: 'https://github.com/YannickVa/fluxer/releases/latest/download',
			downloadPageUrl: 'https://github.com/YannickVa/fluxer/releases/latest',
		},
	);
});

test('rejects a non-HTTPS update override', () => {
	assert.throws(
		() =>
			resolveDesktopUpdateEndpoints({
				channel: 'canary',
				platform: 'win32',
				arch: 'x64',
				updateBaseUrlOverride: 'http://updates.example.test',
			}),
		/PUBLIC_DESKTOP_UPDATE_BASE_URL must use HTTPS/,
	);
});
