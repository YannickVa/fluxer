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

async function compileConfig(defaultEndpoint, outfile) {
	await build({
		stdin: {
			contents: fs.readFileSync(sourcePath, 'utf8'),
			loader: 'ts',
			resolveDir: path.dirname(sourcePath),
			sourcefile: 'DesktopConfig.ts',
		},
		outfile,
		define: {'process.env.PUBLIC_DESKTOP_INSTANCE_ENDPOINT': JSON.stringify(defaultEndpoint)},
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
									"export const CHANNEL_APP_URLS = {stable: 'https://web.fluxer.app', canary: 'https://web.canary.fluxer.app', development: 'http://localhost:5173'}; export const CANARY_MIGRATED_APP_ORIGIN = 'https://canary.fluxer.com'; export const STABLE_MIGRATED_APP_ORIGIN = 'https://fluxer.com';",
								loader: 'js',
							};
						}
						return {contents: 'export default {debug() {}, error() {}, info() {}, warn() {}};', loader: 'js'};
					});
				},
			},
		],
	});

	return import(pathToFileURL(outfile).href);
}

const desktopConfig = await compileConfig('', compiledPath);
const bundledConfig = await compileConfig('https://bundled.example/api', path.join(temporaryDir, 'BundledConfig.mjs'));

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
		assert.equal(desktopConfig.getLegacyAppOrigin(), 'https://matskos.duckdns.org');
		assert.equal(desktopConfig.getInitialInstanceEndpoint(), 'https://matskos.duckdns.org');

		const immediatelyPersisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
		assert.equal(immediatelyPersisted.app_url, undefined);
		assert.equal(immediatelyPersisted.migration_instance_endpoint, 'https://matskos.duckdns.org');
		assert.equal(immediatelyPersisted.legacy_app_origin, 'https://matskos.duckdns.org');

		desktopConfig.setDesktopWindowBehaviorSettings({closeToTray: false});
		const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
		assert.equal(persisted.app_url, undefined);
		assert.equal(persisted.migration_instance_endpoint, 'https://matskos.duckdns.org');
		assert.equal(persisted.legacy_app_origin, 'https://matskos.duckdns.org');
	} finally {
		fs.rmSync(profileDir, {recursive: true, force: true});
	}
});

test('rejects malformed legacy instance URLs and preserves fresh-profile isolation', () => {
	for (const input of [
		'javascript:alert(1)',
		'file:///private',
		'https://user:password@example.com',
		'https://example.com?token=secret',
		'https://example.com#token',
		'bad',
	]) {
		const profileDir = fs.mkdtempSync(path.join(temporaryDir, 'invalid-'));
		fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({app_url: input}));
		desktopConfig.loadDesktopConfig(profileDir);
		assert.equal(desktopConfig.getInitialInstanceEndpoint(), null);
		assert.equal(desktopConfig.getLegacyAppOrigin(), 'https://web.canary.fluxer.app');
	}
});

test('keeps a LAN staging instance distinct from official origin migration', () => {
	const profileDir = fs.mkdtempSync(path.join(temporaryDir, 'lan-'));
	fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({app_url: 'http://192.0.2.10:8443'}));
	desktopConfig.loadDesktopConfig(profileDir);
	assert.equal(desktopConfig.getInitialInstanceEndpoint(), 'http://192.0.2.10:8443');
	assert.equal(desktopConfig.getLegacyAppOrigin(), 'http://192.0.2.10:8443');
	desktopConfig.loadDesktopConfig(fs.mkdtempSync(path.join(temporaryDir, 'fresh-')));
	assert.equal(desktopConfig.getInitialInstanceEndpoint(), null);
});

test('fresh profiles use the compiled default and saved endpoints take precedence', () => {
	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-desktop-bundled-'));
	try {
		bundledConfig.loadDesktopConfig(profileDir);
		assert.equal(bundledConfig.getInitialInstanceEndpoint(), 'https://bundled.example/api');
		fs.writeFileSync(
			path.join(profileDir, 'settings.json'),
			JSON.stringify({migration_instance_endpoint: 'https://chosen.example/api'}),
		);
		bundledConfig.loadDesktopConfig(profileDir);
		assert.equal(bundledConfig.getInitialInstanceEndpoint(), 'https://chosen.example/api');
	} finally {
		fs.rmSync(profileDir, {recursive: true, force: true});
	}
});
