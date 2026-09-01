// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {formatQuietHoursTime, isTimeWithinQuietHours, parseQuietHoursTime} from './NotificationQuietHours';

describe('NotificationQuietHours', () => {
	it('handles a daytime range', () => {
		expect(isTimeWithinQuietHours(9 * 60, 8 * 60, 17 * 60)).toBe(true);
		expect(isTimeWithinQuietHours(18 * 60, 8 * 60, 17 * 60)).toBe(false);
	});

	it('handles a range that crosses midnight', () => {
		expect(isTimeWithinQuietHours(23 * 60, 22 * 60, 8 * 60)).toBe(true);
		expect(isTimeWithinQuietHours(7 * 60 + 59, 22 * 60, 8 * 60)).toBe(true);
		expect(isTimeWithinQuietHours(12 * 60, 22 * 60, 8 * 60)).toBe(false);
	});

	it('treats equal times as an all-day quiet period', () => {
		expect(isTimeWithinQuietHours(12 * 60, 8 * 60, 8 * 60)).toBe(true);
	});

	it('round-trips time input values', () => {
		expect(parseQuietHoursTime('22:30')).toBe(22 * 60 + 30);
		expect(formatQuietHoursTime(22 * 60 + 30)).toBe('22:30');
		expect(parseQuietHoursTime('25:00')).toBeNull();
	});
});
