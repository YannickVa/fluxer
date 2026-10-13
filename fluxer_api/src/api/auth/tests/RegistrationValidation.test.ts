// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {getInstanceConfigRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {createAuthHarness, createUniqueEmail, createUniqueUsername} from '@app/api/auth/tests/AuthTestUtils';
import {applySharedListUpdate, resetSharedListsForTests} from '@app/api/infrastructure/activity/SharedLists';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface ValidationErrorResponse {
	code: string;
	message: string;
	errors?: Array<{
		path: string;
		code: string;
		message: string;
	}>;
}

describe('Registration validation', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	it('rejects blocked registration email TLDs as invalid email', async () => {
		applySharedListUpdate('email_tld_blocked', 'blocked\n');
		try {
			await createBuilderWithoutAuth(harness)
				.post('/auth/register')
				.body({
					email: 'holdermichael_6023@example.blocked',
					username: createUniqueUsername(),
					global_name: 'Test User',
					password: 'a-strong-password',
					date_of_birth: '2000-01-01',
					consent: true,
				})
				.expect(400)
				.execute();
		} finally {
			resetSharedListsForTests();
		}
	});
	it('rejects an impossible calendar date with INVALID_DATE_OF_BIRTH_FORMAT', async () => {
		for (const dateOfBirth of ['2000-02-30', '2000-13-45']) {
			const json = await createBuilderWithoutAuth<ValidationErrorResponse>(harness)
				.post('/auth/register')
				.body({
					email: createUniqueEmail('impossible-dob'),
					username: createUniqueUsername('impossible'),
					global_name: 'Test User',
					password: 'a-strong-password',
					date_of_birth: dateOfBirth,
					consent: true,
				})
				.expect(400, 'INVALID_FORM_BODY')
				.execute();
			const dateOfBirthError = json.errors?.find((e) => e.path === 'date_of_birth');
			expect(dateOfBirthError?.code).toBe('INVALID_DATE_OF_BIRTH_FORMAT');
		}
	});
	it('rejects a real calendar date below the minimum age with MUST_BE_MINIMUM_AGE', async () => {
		const json = await createBuilderWithoutAuth<ValidationErrorResponse>(harness)
			.post('/auth/register')
			.body({
				email: createUniqueEmail('underage'),
				username: createUniqueUsername('underage'),
				global_name: 'Test User',
				password: 'a-strong-password',
				date_of_birth: '2020-01-01',
				consent: true,
			})
			.expect(400, 'INVALID_FORM_BODY')
			.execute();
		const dateOfBirthError = json.errors?.find((e) => e.path === 'date_of_birth');
		expect(dateOfBirthError?.code).toBe('MUST_BE_MINIMUM_AGE');
	});
	it.each([
		'2000-02-30',
		'2001-02-29',
		'1900-02-29',
		'2000-04-31',
	])('rejects impossible birth date %s through the actual registration endpoint', async (dateOfBirth) => {
		const json = await createBuilderWithoutAuth<ValidationErrorResponse>(harness)
			.post('/auth/register')
			.body({
				email: createUniqueEmail(),
				username: createUniqueUsername(),
				password: 'a-strong-password',
				date_of_birth: dateOfBirth,
				consent: true,
			})
			.expect(400, 'INVALID_FORM_BODY')
			.execute();
		expect(json.errors?.find((error) => error.path === 'date_of_birth')?.code).toBe('INVALID_DATE_OF_BIRTH_FORMAT');
	});
	it('preserves the instance option not to collect a birth date during ordinary registration', async () => {
		await getInstanceConfigRepository().setAppPublicConfig({registration: {collect_date_of_birth: false}});
		const result = await createBuilderWithoutAuth<{user_id: string; token: string}>(harness)
			.post('/auth/register')
			.body({
				email: createUniqueEmail(),
				username: createUniqueUsername(),
				password: 'a-strong-password',
				consent: true,
			})
			.execute();
		const user = await getUserRepository().findUniqueAssert(createUserID(BigInt(result.user_id)));
		expect(result.token).toBeTruthy();
		expect(user.dateOfBirth).toBeNull();
	});

});
