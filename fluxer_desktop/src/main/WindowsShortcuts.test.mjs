// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {installElectronStub} from './LocalAppTestSupport.test.mjs';

const {DESKTOP_APP_NAME, WINDOWS_APP_USER_MODEL_ID, WINDOWS_LEGACY_APP_USER_MODEL_IDS, WINDOWS_SHORTCUT_AUTHOR} =
	await import('@electron/common/DesktopIdentity');
const {repairWindowsShortcuts} = await import('@electron/main/WindowsShortcuts');

async function fixture(run) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-shortcut-repair-'));
	const execDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
	const appData = process.env.APPDATA;
	const profile = process.env.USERPROFILE;
	const installation = path.join(root, 'install');
	const currentExe = path.join(installation, 'current', `${DESKTOP_APP_NAME}.exe`);
	const programs = path.join(root, 'profile', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
	fs.mkdirSync(path.dirname(currentExe), {recursive: true});
	fs.mkdirSync(programs, {recursive: true});
	fs.writeFileSync(path.join(installation, 'Update.exe'), 'fixture');
	const shortcut = path.join(programs, `${DESKTOP_APP_NAME}.lnk`);
	fs.writeFileSync(shortcut, 'fixture');
	Object.defineProperty(process, 'execPath', {...execDescriptor, value: currentExe});
	Object.defineProperty(process, 'platform', {...platformDescriptor, value: 'win32'});
	process.env.APPDATA = path.join(root, 'profile');
	delete process.env.USERPROFILE;
	const writes = [];
	const shell = {
		readShortcutLink: () => ({target: path.join(installation, 'old.exe'), args: '--keep', description: 'Keep me'}),
		writeShortcutLink: (...args) => {
			writes.push(args);
			return true;
		},
	};
	installElectronStub({shell});
	try {
		await run({
			shell,
			writes,
			shortcut,
			currentExe,
			authorShortcut: path.join(programs, WINDOWS_SHORTCUT_AUTHOR, `${DESKTOP_APP_NAME}.lnk`),
		});
	} finally {
		Object.defineProperty(process, 'execPath', execDescriptor);
		Object.defineProperty(process, 'platform', platformDescriptor);
		if (appData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = appData;
		if (profile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = profile;
		fs.rmSync(root, {recursive: true, force: true});
	}
}

test('uses Electron to preserve shortcut arguments and repair the target and identity', async () =>
	fixture(async ({writes, currentExe, shortcut}) => {
		await repairWindowsShortcuts();
		assert.equal(writes.length, 1);
		assert.equal(writes[0][1], 'update');
		assert.equal(writes[0][0], shortcut);
		assert.equal(fs.existsSync(shortcut), true);
		assert.equal(writes[0][2].target, currentExe);
		assert.equal(writes[0][2].args, '--keep');
		assert.equal(writes[0][2].description, 'Keep me');
		assert.equal(writes[0][2].appUserModelId, WINDOWS_APP_USER_MODEL_ID);
	}));

test('reports a failed rewrite instead of recording maintenance success', async () =>
	fixture(async ({shell}) => {
		shell.writeShortcutLink = () => false;
		await assert.rejects(repairWindowsShortcuts(), AggregateError);
	}));

test('reports an unreadable root shortcut instead of recording maintenance success', async () =>
	fixture(async ({shell}) => {
		shell.readShortcutLink = () => {
			throw new Error('unreadable shortcut');
		};
		await assert.rejects(
			repairWindowsShortcuts(),
			(error) =>
				error instanceof AggregateError && error.errors.some((failure) => failure.message === 'unreadable shortcut'),
		);
	}));

test('repairs root and author shortcuts in place when both exist', async () =>
	fixture(async ({writes, shortcut, authorShortcut}) => {
		fs.mkdirSync(path.dirname(authorShortcut), {recursive: true});
		fs.writeFileSync(authorShortcut, 'fixture author');
		await repairWindowsShortcuts();
		assert.deepEqual(
			writes.map(([file]) => file),
			[shortcut, authorShortcut],
		);
		assert.equal(fs.existsSync(shortcut), true);
		assert.equal(fs.existsSync(authorShortcut), true);
	}));

test('rewrites a current target with a legacy application identity', async () =>
	fixture(async ({shell, writes, currentExe}) => {
		shell.readShortcutLink = () => ({target: currentExe, appUserModelId: WINDOWS_LEGACY_APP_USER_MODEL_IDS[0]});
		await repairWindowsShortcuts();
		assert.equal(writes.length, 1);
		assert.equal(writes[0][2].appUserModelId, WINDOWS_APP_USER_MODEL_ID);
	}));

test('leaves an already-current shortcut untouched', async () =>
	fixture(async ({shell, writes, currentExe, shortcut}) => {
		shell.readShortcutLink = () => ({target: currentExe, appUserModelId: WINDOWS_APP_USER_MODEL_ID});
		await repairWindowsShortcuts();
		assert.equal(writes.length, 0);
		assert.equal(fs.existsSync(shortcut), true);
	}));

test('leaves an unrelated root shortcut in place without rewriting it', async () =>
	fixture(async ({shell, writes, shortcut}) => {
		shell.readShortcutLink = () => ({target: path.join(os.tmpdir(), 'unrelated', 'Other.exe')});
		await repairWindowsShortcuts();
		assert.equal(writes.length, 0);
		assert.equal(fs.existsSync(shortcut), true);
	}));
