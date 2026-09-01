// SPDX-License-Identifier: AGPL-3.0-or-later

const MINUTES_PER_DAY = 24 * 60;

export function normalizeQuietHoursMinutes(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.trunc(value)));
}

export function isTimeWithinQuietHours(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
	const now = normalizeQuietHoursMinutes(nowMinutes);
	const start = normalizeQuietHoursMinutes(startMinutes);
	const end = normalizeQuietHoursMinutes(endMinutes);
	if (start === end) return true;
	if (start < end) return now >= start && now < end;
	return now >= start || now < end;
}

export function quietHoursMinutesFromDate(date: Date): number {
	return date.getHours() * 60 + date.getMinutes();
}

export function formatQuietHoursTime(value: number): string {
	const normalized = normalizeQuietHoursMinutes(value);
	const hours = Math.floor(normalized / 60)
		.toString()
		.padStart(2, '0');
	const minutes = (normalized % 60).toString().padStart(2, '0');
	return `${hours}:${minutes}`;
}

export function parseQuietHoursTime(value: string): number | null {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match) return null;
	const hours = Number.parseInt(match[1] ?? '', 10);
	const minutes = Number.parseInt(match[2] ?? '', 10);
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
	return hours * 60 + minutes;
}
