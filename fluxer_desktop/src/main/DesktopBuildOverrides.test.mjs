// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import {validateDesktopBuildOverrides} from '../../scripts/validate-build-overrides.mjs';

const bundled = {
	PUBLIC_DESKTOP_INSTANCE_ENDPOINT: 'https://matskos.test/api',
	PUBLIC_DESKTOP_UPDATE_BASE_URL: 'https://github.com/YannickVa/fluxer/releases/latest/download',
	PUBLIC_DESKTOP_DOWNLOAD_URL: 'https://github.com/YannickVa/fluxer/releases/latest',
};
const fork = {requireForkSettings: true};

test('fork builds require explicit instance, update and download settings', () => {
	assert.doesNotThrow(() => validateDesktopBuildOverrides(bundled, fork));
	for (const key of Object.keys(bundled)) {
		const missing = {...bundled};
		delete missing[key];
		assert.throws(() => validateDesktopBuildOverrides(missing, fork));
	}
});

test('both module build flag forms require a controlled package origin', () => {
	for (const FLUXER_MODULES of ['1', 'true']) {
		assert.throws(() => validateDesktopBuildOverrides({...bundled, FLUXER_MODULES}, fork));
		assert.doesNotThrow(() =>
			validateDesktopBuildOverrides(
				{...bundled, FLUXER_MODULES, PUBLIC_DESKTOP_PACKAGE_ORIGIN: 'https://packages.matskos.test'},
				fork,
			),
		);
	}
});

test('invalid embedded settings fail before producing a client bundle', () => {
	for (const value of [
		'http://updates.test',
		'https://user:password@updates.test',
		'https://updates.test/?query=1',
		'https://updates.test/#fragment',
	]) {
		assert.throws(() => validateDesktopBuildOverrides({...bundled, PUBLIC_DESKTOP_UPDATE_BASE_URL: value}, fork));
	}
	assert.throws(() =>
		validateDesktopBuildOverrides({...bundled, PUBLIC_DESKTOP_PACKAGE_ORIGIN: 'https://packages.test/path'}, fork),
	);
	assert.doesNotThrow(() => validateDesktopBuildOverrides({}, {}));
});
