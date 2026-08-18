// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const sourcePath = fileURLToPath(new URL('./DesktopConfig.ts', import.meta.url));
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-desktop-config-'));
const compiledPath = path.join(temporaryDir, 'DesktopConfig.mjs');

await build({
	stdin: {
		contents: fs.readFileSync(sourcePath, 'utf8'),
		loader: 'ts',
		resolveDir: path.dirname(sourcePath),
		sourcefile: 'DesktopConfig.ts',
	},
	outfile: compiledPath,
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node24',
	plugins: [
		{
			name: 'desktop-config-test-stubs',
			setup(esbuild) {
				esbuild.onResolve({filter: /^@electron\/common\/BuildChannel$/}, () => ({
					path: 'build-channel',
					namespace: 'test-stub',
				}));
				esbuild.onResolve({filter: /^@electron\/common\/Constants$/}, () => ({
					path: 'constants',
					namespace: 'test-stub',
				}));
				esbuild.onResolve({filter: /^electron-log$/}, () => ({path: 'electron-log', namespace: 'test-stub'}));
				esbuild.onLoad({filter: /.*/, namespace: 'test-stub'}, ({path: stubPath}) => {
					if (stubPath === 'build-channel') {
						return {contents: "export const BUILD_CHANNEL = 'canary';", loader: 'js'};
					}
					if (stubPath === 'constants') {
						return {
							contents:
								"export const CANARY_APP_URL = 'https://web.canary.fluxer.app'; export const STABLE_APP_URL = 'https://web.fluxer.app';",
							loader: 'js',
						};
					}
					return {contents: 'export default {debug() {}, error() {}, info() {}, warn() {}};', loader: 'js'};
				});
			},
		},
	],
});

const desktopConfig = await import(pathToFileURL(compiledPath).href);

test.after(() => fs.rmSync(temporaryDir, {recursive: true, force: true}));

test('preserves a custom instance URL while upgrading and saving unrelated settings', () => {
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-desktop-profile-'));
	const settingsPath = path.join(profileDir, 'settings.json');
	try {
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				app_url: 'https://matskos.duckdns.org',
				window_behavior: {showTrayIcon: true},
			}),
		);

		desktopConfig.loadDesktopConfig(profileDir);
		assert.equal(desktopConfig.getAppUrl(), 'https://matskos.duckdns.org');
		assert.equal(desktopConfig.getCustomAppUrl(), 'https://matskos.duckdns.org');

		desktopConfig.setDesktopWindowBehaviorSettings({closeToTray: false});
		const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
		assert.equal(persisted.app_url, 'https://matskos.duckdns.org');
	} finally {
		fs.rmSync(profileDir, {recursive: true, force: true});
	}
});
