// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	formatSupportDeviceSummary,
	formatSupportInstanceSummary,
	formatSupportMediaSummary,
	formatSupportUpdateAvailable,
	formatSupportUpdateLastChecked,
} from '@app/features/support/SupportCenterCopy';
import {type I18n, setupI18n} from '@lingui/core';
import {describe, expect, test, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));

const i18n = setupI18n({locale: 'en-US', messages: {'en-US': {}}});
const optimizedFallbackI18n = {
	_: (descriptor: Parameters<I18n['_']>[0], values?: Parameters<I18n['_']>[1]) => {
		if (typeof descriptor === 'string') return i18n._(descriptor, values);
		const {id, message, comment} = descriptor;
		return i18n._({id, message, comment}, values);
	},
} as unknown as I18n;
const passingCheck = (service: 'app' | 'api' | 'media', durationMs: number) => ({
	service,
	status: 'pass' as const,
	httpStatus: 200,
	durationMs,
	error: null,
});

describe('SupportCenterCopy', () => {
	test('interpolates endpoint summaries without positional placeholders', () => {
		expect(formatSupportInstanceSummary(i18n, passingCheck('app', 12), passingCheck('api', 34))).toBe(
			'App 12 ms · API 34 ms',
		);
		expect(formatSupportMediaSummary(i18n, passingCheck('media', 56))).toBe('Media service 56 ms.');
	});

	test('interpolates device counts and permission states', () => {
		expect(formatSupportDeviceSummary(i18n, 1, 2, 3, 'granted', 'prompt')).toBe(
			'1 microphone(s), 2 speaker(s), 3 camera(s). Microphone allowed; camera not requested.',
		);
	});

	test('interpolates update details', () => {
		expect(formatSupportUpdateAvailable(i18n, '2026.820.7')).toBe('Version 2026.820.7 is available.');
		expect(formatSupportUpdateLastChecked(i18n, 'Aug 20, 2026, 6:00 PM')).toBe('Last checked: Aug 20, 2026, 6:00 PM');
	});

	test('passes interpolation values separately for optimized fallback builds', () => {
		expect(formatSupportInstanceSummary(optimizedFallbackI18n, passingCheck('app', 12), passingCheck('api', 34))).toBe(
			'App 12 ms · API 34 ms',
		);
		expect(formatSupportMediaSummary(optimizedFallbackI18n, passingCheck('media', 56))).toBe('Media service 56 ms.');
		expect(formatSupportDeviceSummary(optimizedFallbackI18n, 1, 2, 3, 'granted', 'prompt')).toBe(
			'1 microphone(s), 2 speaker(s), 3 camera(s). Microphone allowed; camera not requested.',
		);
		expect(formatSupportUpdateAvailable(optimizedFallbackI18n, '2026.820.7')).toBe('Version 2026.820.7 is available.');
		expect(formatSupportUpdateLastChecked(optimizedFallbackI18n, 'Aug 20, 2026, 6:00 PM')).toBe(
			'Last checked: Aug 20, 2026, 6:00 PM',
		);
	});

	test('never exposes raw placeholders', () => {
		const rendered = [
			formatSupportInstanceSummary(i18n, passingCheck('app', 12), passingCheck('api', 34)),
			formatSupportMediaSummary(i18n, passingCheck('media', 56)),
			formatSupportDeviceSummary(i18n, 1, 2, 3, 'granted', 'prompt'),
		].join(' ');
		expect(rendered).not.toMatch(/\{[^{}]+\}/);
	});
});
