// SPDX-License-Identifier: AGPL-3.0-or-later

import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {InvalidTokenError} from '@fluxer/errors/src/domains/core/InvalidTokenError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {
	MigrationClaimCompleteRequest,
	MigrationClaimEmailRequest,
	MigrationClaimRedeemRequest,
} from '@fluxer/schema/src/domains/auth/MigrationClaimSchemas';
import {types} from 'cassandra-driver';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi} from 'vitest';
import type {ApiContext} from '../../ApiContext';
import {createUserID, type UserID} from '../../BrandedTypes';
import {createApiContext} from '../../CreateApiContext';
import {fetchMany, upsertOne} from '../../database/CassandraQueryExecution';
import {Db} from '../../database/CassandraTypes';
import {EMPTY_USER_ROW} from '../../database/types/UserTypes';
import {getInstanceConfigRepository} from '../../middleware/ServiceSingletons';
import {AuthSessions, Users} from '../../Tables';
import type {ApiTestHarness} from '../../test/ApiTestHarness';
import {UserEmailOwnershipRepository} from '../../user/repositories/account/crud/UserEmailOwnershipRepository';
import {canUserAccessNsfwContent} from '../../utils/AgeUtils';
import * as IpUtils from '../../utils/IpUtils';
import * as AuthPassword from '../AuthPassword';
import {MigrationClaimCompletionService} from '../services/MigrationClaimCompletionService';
import {type MigrationClaimContext, MigrationClaimTicketService} from '../services/MigrationClaimTicketService';
import {createAuthHarness, findLastTestEmail, listTestEmails} from './AuthTestUtils';

const ID = createUserID(1400000000000000102n);
const OTHER = createUserID(1400000000000000103n);
const CONTEXT: MigrationClaimContext = {
	instanceFingerprint: 'a'.repeat(64),
	migrationRunId: '09b9adba-70d0-41d9-9fc4-bb7b9f6a2e68',
	sourceGuildId: '1400000000000000000',
};
const PASSWORD = 'Unique-synthetic-claim-password_27';
const request = () =>
	new Request('http://localhost/auth/migration/complete', {headers: {'x-forwarded-for': '127.0.0.1'}});

describe('Restricted migrated-account claim completion', () => {
	let harness: ApiTestHarness;
	let api: ApiContext;
	let service: MigrationClaimCompletionService;
	let tickets: MigrationClaimTicketService;
	let mail: MockInstance<ApiContext['services']['email']['sendEmailChangeNew']>;
	const policy = {getMinimumAgeForRegion: vi.fn(() => 13)};

	async function seed(id: UserID = ID) {
		await upsertOne(
			Users.upsertAll({
				...EMPTY_USER_ROW,
				user_id: id,
				username: `synthetic-${id}`,
				discriminator: 0,
				bio: 'preserve profile',
				traits: new Set(['discord_seed', `discord_id:${id}`]),
				version: 1,
			}),
		);
	}
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		await seed();
		api = createApiContext();
		const instance = getInstanceConfigRepository();
		vi.spyOn(instance, 'isEmailEnabled').mockResolvedValue(true);
		mail = vi.spyOn(api.services.email, 'sendEmailChangeNew').mockResolvedValue(true);
		vi.spyOn(api.services.emailDnsValidation, 'hasValidDnsRecords').mockResolvedValue(true);
		vi.spyOn(AuthPassword, 'isPasswordPwned').mockResolvedValue(false);
		policy.getMinimumAgeForRegion.mockReset().mockReturnValue(13);
		service = new MigrationClaimCompletionService(api, {instance, accountPolicy: policy}, CONTEXT);
		tickets = new MigrationClaimTicketService(api.services.cache, api.services.users, CONTEXT);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function proof(id: UserID = ID) {
		const issued = await tickets.issue(id, id.toString());
		return {issued, accepted: await service.redeem({token: issued.token, confirm: true})};
	}
	async function prepared(id: UserID = ID, email = 'synthetic-claim@example.com') {
		const result = await proof(id);
		const challenge = await service.requestEmail({proof: result.accepted.proof, email});
		const code = mail.mock.calls.at(-1)![2];
		const data: MigrationClaimCompleteRequest = {
			proof: result.accepted.proof,
			challenge: challenge.challenge,
			code,
			password: PASSWORD,
			date_of_birth: '2000-02-29',
			consent: true,
		};
		return {...result, challenge, data};
	}

	it('verifies email, hashes the password, applies the self-supplied DOB, preserves the profile and requires normal login', async () => {
		const {data} = await prepared();
		expect(canUserAccessNsfwContent(await api.services.users.findUniqueAssert(ID))).toBe(false);
		const result = await service.complete(data, request());
		expect(result).toEqual({user_id: ID.toString(), login_required: true});
		const user = await api.services.users.findUniqueAssert(ID);
		expect(user.email).toBe('synthetic-claim@example.com');
		expect(user.emailVerified).toBe(true);
		expect(user.bio).toBe('preserve profile');
		expect(user.dateOfBirth?.toString()).toBe('2000-02-29');
		expect(canUserAccessNsfwContent(user)).toBe(true);
		expect(await AuthPassword.verifyPassword(api, {password: PASSWORD, passwordHash: user.passwordHash!})).toBe(true);
		expect(await fetchMany(AuthSessions.select().bind({}))).toEqual([]);
		const normalLogin = await harness.requestJson({
			path: '/auth/login',
			method: 'POST',
			body: {email: user.email, password: PASSWORD},
		});
		const loginBody = await normalLogin.json();
		expect(normalLogin.status).toBe(403);
		expect(loginBody).toMatchObject({code: 'IP_AUTHORIZATION_REQUIRED', ip_authorization_required: true});
		const authorizationEmail = findLastTestEmail(
			await listTestEmails(harness, {recipient: user.email!}),
			'ip_authorization',
		);
		expect(authorizationEmail).not.toBeNull();
		const authorized = await harness.requestJson({
			path: '/auth/authorize-ip',
			method: 'POST',
			body: {token: authorizationEmail!.metadata['token']},
		});
		expect(authorized.status).toBe(204);
		const retry = await harness.requestJson({
			path: '/auth/login',
			method: 'POST',
			body: {email: user.email, password: PASSWORD},
		});
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({user_id: ID.toString(), token: expect.stringMatching(/^flx_/)});
	});

	it('requires explicit confirmation before consuming an ownership link', async () => {
		const issued = await tickets.issue(ID, ID.toString());
		await expect(service.redeem({token: issued.token, confirm: false} as never)).rejects.toThrow();
		await expect(service.redeem({token: issued.token, confirm: true})).resolves.toHaveProperty('proof');
		await expect(service.redeem({token: issued.token, confirm: true})).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('restricted credentials cannot authenticate an ordinary API request', async () => {
		const {issued, accepted} = await proof();
		for (const token of [issued.token, accepted.proof]) {
			const response = await harness.requestJson({path: '/users/@me', headers: {Authorization: token}});
			expect(response.status).toBe(401);
		}
	});

	it('stores only hash-keyed credentials and a code hash, never plaintext tokens, codes or passwords', async () => {
		const writes = vi.spyOn(api.services.cache, 'set');
		const {issued, accepted, challenge, data} = await prepared();
		const stored = JSON.stringify(writes.mock.calls);
		for (const secret of [issued.token, accepted.proof, challenge.challenge, data.code, PASSWORD])
			expect(stored).not.toContain(secret);
	});

	it('allows a code typo to be corrected without consuming ownership or changing the account', async () => {
		const {data} = await prepared();
		await expect(service.complete({...data, code: 'WRONG-CODE'}, request())).rejects.toBeInstanceOf(
			InputValidationError,
		);
		expect((await api.services.users.findUniqueAssert(ID)).passwordHash).toBeNull();
		await expect(service.complete(data, request())).resolves.toHaveProperty('login_required', true);
	});

	it('never accepts another account’s email challenge or a challenge from another proof generation', async () => {
		await seed(OTHER);
		const first = await prepared();
		const other = await prepared(OTHER, 'synthetic-other@example.com');
		await expect(
			service.complete({...first.data, challenge: other.data.challenge, code: other.data.code}, request()),
		).rejects.toBeInstanceOf(InvalidTokenError);
		await tickets.issue(ID, ID.toString());
		await expect(service.complete(first.data, request())).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('revoking the ownership generation also invalidates its already redeemed restricted proof', async () => {
		const {data} = await prepared();
		await tickets.revoke(ID);
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('isolates proof state from another instance and migration run', async () => {
		const {accepted} = await proof();
		const foreign = new MigrationClaimCompletionService(
			api,
			{instance: getInstanceConfigRepository(), accountPolicy: policy},
			{...CONTEXT, instanceFingerprint: 'b'.repeat(64)},
		);
		await expect(foreign.requestEmail({proof: accepted.proof, email: 'synthetic@example.com'})).rejects.toBeInstanceOf(
			InvalidTokenError,
		);
	});

	it('keeps the original deadline even when email verification starts near the end of the ownership lifetime', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {issued, accepted} = await proof();
		vi.advanceTimersByTime(14 * 60_000);
		const challenge = await service.requestEmail({proof: accepted.proof, email: 'synthetic@example.com'});
		expect(challenge.expires_at).toBe(issued.expiresAt.toISOString());
		vi.advanceTimersByTime(60_000);
		await expect(
			service.complete(
				{
					proof: accepted.proof,
					challenge: challenge.challenge,
					code: mail.mock.calls[0]![2],
					password: PASSWORD,
					date_of_birth: '2000-02-29',
					consent: true,
				},
				request(),
			),
		).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('refuses expiry during mail delivery without publishing a usable challenge', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {accepted} = await proof();
		mail.mockImplementation(async () => {
			vi.advanceTimersByTime(900_000);
			return true;
		});
		await expect(service.requestEmail({proof: accepted.proof, email: 'synthetic@example.com'})).rejects.toBeInstanceOf(
			InvalidTokenError,
		);
		expect((await api.services.users.findUniqueAssert(ID)).email).toBeNull();
	});

	it('refuses expiry while publishing the email challenge pointer', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {accepted} = await proof();
		const set = api.services.cache.set.bind(api.services.cache);
		vi.spyOn(api.services.cache, 'set').mockImplementation(async (...args) => {
			await set(...args);
			if (args[0].includes(':email-current:')) vi.advanceTimersByTime(900_000);
		});
		await expect(service.requestEmail({proof: accepted.proof, email: 'synthetic@example.com'})).rejects.toBeInstanceOf(
			InvalidTokenError,
		);
		expect((await api.services.users.findUniqueAssert(ID)).email).toBeNull();
	});

	it('refuses expiry during password hashing, before any account claim', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {data} = await prepared();
		vi.spyOn(AuthPassword, 'hashPassword').mockImplementation(async () => {
			vi.advanceTimersByTime(900_000);
			return 'synthetic-hash';
		});
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InvalidTokenError);
		expect((await api.services.users.findUniqueAssert(ID)).passwordHash).toBeNull();
	});

	it('refuses expiry while reserving the verified email at the repository boundary', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {data} = await prepared();
		const reserve = UserEmailOwnershipRepository.prototype.claimEmail;
		vi.spyOn(UserEmailOwnershipRepository.prototype, 'claimEmail').mockImplementation(async function (
			this: UserEmailOwnershipRepository,
			...args
		) {
			const result = await reserve.apply(this, args);
			vi.advanceTimersByTime(900_000);
			return result;
		});
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InvalidTokenError);
		expect((await api.services.users.findUniqueAssert(ID)).email).toBeNull();
	});

	it.each([
		'2023-02-29',
		'2026-02-30',
		'2099-01-01',
		'2020-01-01',
	])('refuses invalid, future or underage DOB %s without consuming a correct challenge', async (dob) => {
		const {data} = await prepared();
		await expect(service.complete({...data, date_of_birth: dob}, request())).rejects.toBeInstanceOf(
			InputValidationError,
		);
		expect((await api.services.users.findUniqueAssert(ID)).dateOfBirth).toBeNull();
		await expect(service.complete(data, request())).resolves.toHaveProperty('login_required', true);
	});

	it('uses the trusted regional age policy, not a client-supplied minimum', async () => {
		const {data} = await prepared();
		vi.spyOn(IpUtils, 'lookupGeoip').mockResolvedValue({
			countryCode: 'BE',
			normalizedIp: '127.0.0.1',
			city: null,
			region: null,
			countryName: null,
		});
		policy.getMinimumAgeForRegion.mockReturnValue(16);
		await expect(service.complete({...data, date_of_birth: '2011-01-01'}, request())).rejects.toBeInstanceOf(
			InputValidationError,
		);
		expect(policy.getMinimumAgeForRegion).toHaveBeenCalledWith('BE', 13);
	});

	it('preserves an existing DOB and does not turn claiming into DOB editing', async () => {
		await upsertOne(Users.patchByPk({user_id: ID}, {date_of_birth: Db.set(types.LocalDate.fromString('2001-01-01'))}));
		const {accepted, data} = await prepared();
		expect(accepted.date_of_birth_required).toBe(false);
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InvalidTokenError);
		await service.complete({...data, date_of_birth: undefined}, request());
		expect((await api.services.users.findUniqueAssert(ID)).dateOfBirth?.toString()).toBe('2001-01-01');
	});

	it('requires the configured legal consent and records the applicable consent dates', async () => {
		const instance = getInstanceConfigRepository();
		const config = await instance.getAppPublicConfig();
		vi.spyOn(instance, 'getAppPublicConfig').mockResolvedValue({
			...config,
			legal: {...config.legal, terms_url: 'https://example.com/terms', privacy_url: 'https://example.com/privacy'},
		});
		const {data} = await prepared();
		await expect(service.complete({...data, consent: false}, request())).rejects.toBeInstanceOf(InputValidationError);
		await service.complete(data, request());
		const user = await api.services.users.findUniqueAssert(ID);
		expect(user.termsAgreedAt).toBeInstanceOf(Date);
		expect(user.privacyAgreedAt).toBeInstanceOf(Date);
	});

	it('applies the existing password policy and pwned-password rejection before consuming the proof', async () => {
		const {data} = await prepared();
		await expect(service.complete({...data, password: 'short'}, request())).rejects.toThrow();
		vi.mocked(AuthPassword.isPasswordPwned).mockResolvedValue(true);
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InputValidationError);
		expect((await api.services.users.findUniqueAssert(ID)).passwordHash).toBeNull();
	});

	it('does not pretend mail was sent when disabled or when the sender returns failure', async () => {
		const {accepted} = await proof();
		mail.mockResolvedValue(false);
		await expect(service.requestEmail({proof: accepted.proof, email: 'synthetic@example.com'})).rejects.toBeInstanceOf(
			ServiceUnavailableError,
		);
		await seed(OTHER);
		const other = await proof(OTHER);
		vi.mocked(getInstanceConfigRepository().isEmailEnabled).mockResolvedValue(false);
		await expect(
			service.requestEmail({proof: other.accepted.proof, email: 'synthetic-other@example.com'}),
		).rejects.toBeInstanceOf(ServiceUnavailableError);
		expect(mail).toHaveBeenCalledTimes(1);
	});

	it('rejects an address with invalid DNS before sending its verification code', async () => {
		const {accepted} = await proof();
		vi.mocked(api.services.emailDnsValidation.hasValidDnsRecords).mockResolvedValue(false);
		await expect(service.requestEmail({proof: accepted.proof, email: 'synthetic@example.com'})).rejects.toBeInstanceOf(
			InputValidationError,
		);
		expect(mail).not.toHaveBeenCalled();
	});

	it('enforces the per-account send cooldown and invalidates an older challenge after a resend', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {accepted, data} = await prepared();
		await expect(
			service.requestEmail({proof: accepted.proof, email: 'synthetic-new@example.com'}),
		).rejects.toBeInstanceOf(RateLimitError);
		vi.advanceTimersByTime(30_000);
		const next = await service.requestEmail({proof: accepted.proof, email: 'synthetic-new@example.com'});
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InvalidTokenError);
		await service.complete({...data, challenge: next.challenge, code: mail.mock.calls.at(-1)![2]}, request());
		expect((await api.services.users.findUniqueAssert(ID)).email).toBe('synthetic-new@example.com');
	});

	it('limits code-guessing attempts per account rather than per attacker-chosen credential', async () => {
		const {data} = await prepared();
		for (let i = 0; i < 10; i++)
			await expect(service.complete({...data, code: 'WRONG-CODE'}, request())).rejects.toBeInstanceOf(
				InputValidationError,
			);
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(RateLimitError);
	});

	it('allows only one final claimant across simultaneous completion requests', async () => {
		const {data} = await prepared();
		// Keep this contention test lightweight; the happy path above verifies real hashing.
		vi.spyOn(AuthPassword, 'hashPassword').mockResolvedValue('synthetic-race-hash');
		const results = await Promise.allSettled(Array.from({length: 8}, () => service.complete(data, request())));
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(7);
		expect((await api.services.users.findUniqueAssert(ID)).passwordHash).toBe('synthetic-race-hash');
	});

	it('reports a late email reservation conflict as terminal after consuming the proof', async () => {
		const {data} = await prepared();
		vi.spyOn(api.services.users, 'claimMigratedAccount').mockRejectedValue(
			InputValidationError.fromCode('email', ValidationErrorCodes.EMAIL_ALREADY_IN_USE),
		);
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InvalidTokenError);
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InvalidTokenError);
		expect((await api.services.users.findUniqueAssert(ID)).passwordHash).toBeNull();
	});

	it('does not restore consumed proofs after an uncertain final write', async () => {
		const {data} = await prepared();
		vi.spyOn(api.services.users, 'claimMigratedAccount').mockRejectedValue(
			new Error('synthetic uncertain database outcome'),
		);
		await expect(service.complete(data, request())).rejects.toThrow('synthetic uncertain database outcome');
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('refuses privilege changes while password hashing is in flight', async () => {
		const {data} = await prepared();
		vi.spyOn(AuthPassword, 'hashPassword').mockImplementation(async () => {
			await upsertOne(Users.patchByPk({user_id: ID}, {acls: Db.set(new Set(['*']))}));
			return 'synthetic-hash';
		});
		await expect(service.complete(data, request())).rejects.toBeInstanceOf(InvalidTokenError);
		expect((await api.services.users.findUniqueAssert(ID)).passwordHash).toBeNull();
	});

	it('strict contracts refuse client-selected identities, run context, expiry or verification status', () => {
		const token = `mc1.${'A'.repeat(43)}`;
		expect(MigrationClaimRedeemRequest.safeParse({token, confirm: true, user_id: OTHER.toString()}).success).toBe(
			false,
		);
		expect(MigrationClaimRedeemRequest.safeParse({token: ` ${token}`, confirm: true}).success).toBe(false);
		expect(
			MigrationClaimEmailRequest.safeParse({
				proof: `mp1.${'A'.repeat(43)}`,
				email: 'synthetic@example.com',
				context: CONTEXT,
			}).success,
		).toBe(false);
		expect(
			MigrationClaimCompleteRequest.safeParse({
				proof: `mp1.${'A'.repeat(43)}`,
				challenge: `me1.${'A'.repeat(43)}`,
				code: '1234-5678',
				password: PASSWORD,
				expiresAt: 9999999999999,
				email_verified: true,
			}).success,
		).toBe(false);
	});
});
