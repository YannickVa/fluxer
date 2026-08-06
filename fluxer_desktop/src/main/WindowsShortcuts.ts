// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import {
	DESKTOP_APP_NAME,
	WINDOWS_APP_USER_MODEL_ID,
	WINDOWS_LEGACY_APP_USER_MODEL_IDS,
	WINDOWS_SHORTCUT_AUTHOR,
	WINDOWS_TOAST_ACTIVATOR_CLSID,
} from '@electron/common/DesktopIdentity';
import {shouldRepairWindowsShortcut} from '@electron/main/WindowsShortcutPolicy';
import {shell} from 'electron';

interface WindowsShortcutRepairPaths {
	authorShortcut: string;
	currentDir: string;
	currentExe: string;
	rootAppDir: string;
	rootShortcut: string;
}

function getProgramsDir(): string | null {
	const appData = process.env.APPDATA;
	if (!appData) return null;
	return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function getWindowsShortcutRepairPaths(): WindowsShortcutRepairPaths | null {
	const currentExe = process.execPath;
	const currentDir = path.dirname(currentExe);
	if (path.basename(currentDir).toLowerCase() !== 'current') return null;
	const rootAppDir = path.dirname(currentDir);
	if (!fs.existsSync(path.join(rootAppDir, 'Update.exe'))) return null;
	const programsDir = getProgramsDir();
	if (!programsDir) return null;
	const shortcutName = `${DESKTOP_APP_NAME}.lnk`;
	return {
		authorShortcut: path.join(programsDir, WINDOWS_SHORTCUT_AUTHOR, shortcutName),
		currentDir,
		currentExe,
		rootAppDir,
		rootShortcut: path.join(programsDir, shortcutName),
	};
}

function repairOneShortcut(shortcutPath: string, repair: WindowsShortcutRepairPaths): void {
	if (!fs.existsSync(shortcutPath)) return;
	let details: Electron.ShortcutDetails;
	try {
		details = shell.readShortcutLink(shortcutPath);
	} catch (error) {
		console.warn('[WindowsShortcuts] Failed to inspect shortcut', {shortcutPath, error});
		return;
	}
	if (
		!shouldRepairWindowsShortcut(
			{target: details.target, appUserModelId: details.appUserModelId},
			repair.currentExe,
			repair.rootAppDir,
			WINDOWS_LEGACY_APP_USER_MODEL_IDS,
		)
	) {
		return;
	}
	try {
		const updated = shell.writeShortcutLink(shortcutPath, 'update', {
			target: repair.currentExe,
			cwd: repair.currentDir,
			args: details.args,
			description: details.description,
			icon: repair.currentExe,
			iconIndex: 0,
			appUserModelId: WINDOWS_APP_USER_MODEL_ID,
			toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR_CLSID,
		});
		if (!updated) throw new Error('Electron shell.writeShortcutLink returned false');
	} catch (error) {
		console.warn('[WindowsShortcuts] Failed to rewrite shortcut', {shortcutPath, error});
	}
}

function migrateRootShortcut(repairPaths: WindowsShortcutRepairPaths): void {
	try {
		if (!fs.existsSync(repairPaths.rootShortcut)) return;
		const authorDir = path.dirname(repairPaths.authorShortcut);
		fs.mkdirSync(authorDir, {recursive: true});
		if (fs.existsSync(repairPaths.authorShortcut)) {
			fs.rmSync(repairPaths.rootShortcut, {force: true});
		} else {
			fs.renameSync(repairPaths.rootShortcut, repairPaths.authorShortcut);
		}
	} catch (error) {
		console.warn('[WindowsShortcuts] Failed to migrate root Start-Menu shortcut', error);
	}
}

export async function repairWindowsShortcuts(): Promise<void> {
	if (process.platform !== 'win32') return;
	const repairPaths = getWindowsShortcutRepairPaths();
	if (!repairPaths) return;
	migrateRootShortcut(repairPaths);
	const shortcutPaths: Array<string> = [repairPaths.authorShortcut];
	const desktopDir = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : '';
	if (desktopDir) shortcutPaths.push(path.join(desktopDir, `${DESKTOP_APP_NAME}.lnk`));
	if (process.env.APPDATA) {
		shortcutPaths.push(
			path.join(
				process.env.APPDATA,
				'Microsoft',
				'Internet Explorer',
				'Quick Launch',
				'User Pinned',
				'TaskBar',
				`${DESKTOP_APP_NAME}.lnk`,
			),
		);
	}
	for (const shortcutPath of shortcutPaths) repairOneShortcut(shortcutPath, repairPaths);
}
