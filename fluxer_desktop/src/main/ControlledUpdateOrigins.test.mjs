// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import {installTestModuleStub} from './LocalAppTestSupport.test.mjs';

installTestModuleStub('@electron/common/BuildChannel', "export const BUILD_CHANNEL = 'canary';");
const {resolveDesktopPackageOrigin, getUpdateBaseUrl, buildManualLatestDownloadUrl} = await import(
	'./ShellDownloadFormats.ts'
);
const keys = [
	'FLUXER_DESKTOP_PACKAGE_ORIGIN',
	'PUBLIC_DESKTOP_PACKAGE_ORIGIN',
	'PUBLIC_DESKTOP_UPDATE_BASE_URL',
	'PUBLIC_DESKTOP_DOWNLOAD_URL',
	'FLUXER_MODULES',
];

function withEnvironment(values, run) {
	const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	try {
		for (const key of keys) {
			if (values[key] == null) delete process.env[key];
			else process.env[key] = values[key];
		}
		run();
	} finally {
		for (const key of keys) {
			if (original[key] == null) delete process.env[key];
			else process.env[key] = original[key];
		}
	}
}

test('a controlled package origin supplies both shell and module update locations', () => {
	withEnvironment({PUBLIC_DESKTOP_PACKAGE_ORIGIN: 'https://packages.matskos.test/', FLUXER_MODULES: '1'}, () => {
		assert.equal(resolveDesktopPackageOrigin(), 'https://packages.matskos.test');
		assert.equal(
			getUpdateBaseUrl('win32'),
			`https://packages.matskos.test/desktop/canary/win32/${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
		);
	});
});

test('bundled shell updates retain the controlled GitHub feed exactly', () => {
	withEnvironment(
		{
			PUBLIC_DESKTOP_UPDATE_BASE_URL: 'https://github.com/YannickVa/fluxer/releases/latest/download/',
			PUBLIC_DESKTOP_DOWNLOAD_URL: 'https://github.com/YannickVa/fluxer/releases/latest/',
		},
		() => {
			assert.equal(getUpdateBaseUrl(), 'https://github.com/YannickVa/fluxer/releases/latest/download');
			assert.equal(buildManualLatestDownloadUrl('setup'), 'https://github.com/YannickVa/fluxer/releases/latest');
		},
	);
});

test('module builds fail closed when only the legacy shell feed is configured', () => {
	withEnvironment({PUBLIC_DESKTOP_UPDATE_BASE_URL: 'https://updates.matskos.test/feed', FLUXER_MODULES: '1'}, () => {
		assert.throws(resolveDesktopPackageOrigin, /require PUBLIC_DESKTOP_PACKAGE_ORIGIN/);
	});
});

test('embedded package origins reject credentials, paths, queries, fragments and plaintext', () => {
	for (const origin of [
		'https://user:secret@updates.test',
		'https://updates.test/path',
		'https://updates.test/?x=1',
		'https://updates.test/#x',
		'http://updates.test',
		'http://localhost:48780',
	]) {
		withEnvironment({PUBLIC_DESKTOP_PACKAGE_ORIGIN: origin}, () => assert.throws(resolveDesktopPackageOrigin));
	}
});

test('release rehearsal permits an explicit runtime loopback origin only', () => {
	withEnvironment({FLUXER_DESKTOP_PACKAGE_ORIGIN: 'http://127.0.0.1:48780'}, () =>
		assert.equal(resolveDesktopPackageOrigin(), 'http://127.0.0.1:48780'),
	);
	withEnvironment({FLUXER_DESKTOP_PACKAGE_ORIGIN: 'http://192.168.0.149:48780'}, () =>
		assert.throws(resolveDesktopPackageOrigin),
	);
});
