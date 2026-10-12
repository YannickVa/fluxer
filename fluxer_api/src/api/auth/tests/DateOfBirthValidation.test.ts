// SPDX-License-Identifier: AGPL-3.0-or-later

import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ApiContext} from '../../ApiContext';
import * as AgeUtils from '../../utils/AgeUtils';
import {validateAge, validateDateOfBirth} from '../AuthUtility';

const ctx = {} as ApiContext;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function today() {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 8, 30, 12));
}

function expectDobError(dateOfBirth: string, minAge: number, code: string) {
	try {
		validateDateOfBirth(ctx, {dateOfBirth, minAge});
		throw new Error('Expected date-of-birth validation to fail');
	} catch (error) {
		expect(error).toBeInstanceOf(InputValidationError);
		expect((error as InputValidationError).getLocalizedErrors()).toEqual([
			{
				path: 'date_of_birth',
				code,
				variables: code === ValidationErrorCodes.MUST_BE_MINIMUM_AGE ? {minAge} : undefined,
			},
		]);
	}
}

describe('Shared registration and migration-claim birth-date validation', () => {
	it.each([
		'',
		'2000-2-29',
		'2000-02-29T00:00:00Z',
		' 2000-02-29 ',
		'not-a-date',
		'0000-01-01',
		'10000-01-01',
		'2000-00-01',
		'2000-13-01',
		'2000-01-00',
		'2000-01-32',
		'2000-04-31',
		'2000-02-30',
		'2001-02-29',
		'1900-02-29',
	])('rejects invalid calendar input %s instead of normalizing or accepting it', (value) => {
		today();
		expect(AgeUtils.parseDateOfBirth(value)).toBeNull();
		expect(validateAge(ctx, {dateOfBirth: value, minAge: 13})).toBe(false);
		expect(AgeUtils.isUserAdult(value)).toBe(false);
		expectDobError(value, 13, ValidationErrorCodes.INVALID_DATE_OF_BIRTH_FORMAT);
	});

	it.each([
		'2000-02-29',
		'2004-02-29',
		'1900-02-28',
		'2000-04-30',
		'0001-01-01',
		'0099-12-31',
	])('preserves the exact calendar date %s without time-zone or year normalization', (value) => {
		today();
		expect(validateDateOfBirth(ctx, {dateOfBirth: value, minAge: 13}).toString()).toBe(value);
	});

	it.each([
		'America/Los_Angeles',
		'Europe/Brussels',
		'Pacific/Kiritimati',
	])('does not grant minimum-age or mature eligibility a day early in %s', (timeZone) => {
		vi.stubEnv('TZ', timeZone);
		today();
		expect(validateAge(ctx, {dateOfBirth: '2013-09-30', minAge: 13})).toBe(true);
		expect(validateAge(ctx, {dateOfBirth: '2013-10-01', minAge: 13})).toBe(false);
		expect(AgeUtils.isUserAdult('2008-09-30')).toBe(true);
		expect(AgeUtils.isUserAdult('2008-10-01')).toBe(false);
		expect(AgeUtils.calculateAge({year: 2013, month: 9, day: 30})).toBe(13);
	});

	it('uses the supplied instance minimum age without replacing it with the default', () => {
		today();
		expect(validateDateOfBirth(ctx, {dateOfBirth: '2012-09-30', minAge: 13}).toString()).toBe('2012-09-30');
		expectDobError('2012-09-30', 16, ValidationErrorCodes.MUST_BE_MINIMUM_AGE);
	});

	it.each(['2026-09-30', '2026-10-01', '9999-12-31'])('rejects underage and future birthday %s', (value) => {
		today();
		expectDobError(value, 13, ValidationErrorCodes.MUST_BE_MINIMUM_AGE);
		expect(AgeUtils.isUserAdult(value)).toBe(false);
	});

	it('fails closed on invalid policy values and invalid stored dates; never bypasses staff/owner age rules', () => {
		today();
		for (const minAge of [Number.NaN, 0, -1, 13.5]) {
			expect(validateAge(ctx, {dateOfBirth: '2000-01-01', minAge})).toBe(false);
		}
		expect(AgeUtils.canUserAccessNsfwContent({isBot: false, dateOfBirth: null})).toBe(false);
		expect(AgeUtils.canUserAccessNsfwContent({isBot: false, dateOfBirth: {year: 2000, month: 2, day: 30}})).toBe(false);
		expect(AgeUtils.canUserAccessNsfwContent({isBot: true, dateOfBirth: null})).toBe(true);
	});
});
