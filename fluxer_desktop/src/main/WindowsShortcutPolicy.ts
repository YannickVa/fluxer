// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path';

export interface WindowsShortcutSnapshot {
	target: string;
	appUserModelId?: string;
}

function normalizeWindowsPath(candidate: string): string {
	return path.resolve(candidate).replace(/[\\/]+$/, '').toLowerCase();
}

function isPathWithinRoot(candidate: string, rootDir: string): boolean {
	if (!candidate || !rootDir) return false;
	try {
		const normalized = normalizeWindowsPath(candidate);
		const normalizedRoot = normalizeWindowsPath(rootDir);
		return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`);
	} catch {
		return false;
	}
}

function matchesInstallLayout(candidate: string, currentExe: string, rootAppDir: string): boolean {
	try {
		const relativeExecutable = path.relative(rootAppDir, currentExe);
		if (relativeExecutable.startsWith('..') || path.isAbsolute(relativeExecutable)) return false;
		const expectedSuffix = path
			.join(path.basename(rootAppDir), relativeExecutable)
			.replace(/[\\/]+$/, '')
			.toLowerCase();
		return normalizeWindowsPath(candidate).endsWith(`${path.sep}${expectedSuffix}`);
	} catch {
		return false;
	}
}

export function shouldRepairWindowsShortcut(
	shortcut: WindowsShortcutSnapshot,
	currentExe: string,
	rootAppDir: string,
	legacyAppUserModelIds: ReadonlyArray<string>,
): boolean {
	if (
		!isPathWithinRoot(shortcut.target, rootAppDir) &&
		!matchesInstallLayout(shortcut.target, currentExe, rootAppDir)
	) {
		return false;
	}
	const targetIsCurrent = normalizeWindowsPath(shortcut.target) === normalizeWindowsPath(currentExe);
	const appUserModelId = shortcut.appUserModelId?.toLowerCase() ?? '';
	const hasLegacyAppUserModelId = legacyAppUserModelIds.some((candidate) => candidate.toLowerCase() === appUserModelId);
	return !targetIsCurrent || hasLegacyAppUserModelId;
}
