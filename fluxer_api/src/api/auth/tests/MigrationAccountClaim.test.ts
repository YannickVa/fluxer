// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {InvalidTokenError} from '@fluxer/errors/src/domains/core/InvalidTokenError';
import {types} from 'cassandra-driver';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createUserID} from '../../BrandedTypes';
import {upsertOne} from '../../database/CassandraQueryExecution';
import {Db} from '../../database/CassandraTypes';
import {EMPTY_USER_ROW, type UserRow} from '../../database/types/UserTypes';
import {getUserRepository} from '../../middleware/ServiceSingletons';
import {Users} from '../../Tables';
import type {ApiTestHarness} from '../../test/ApiTestHarness';
import {UserDataRepository} from '../../user/repositories/account/crud/UserDataRepository';
import {UserEmailOwnershipRepository} from '../../user/repositories/account/crud/UserEmailOwnershipRepository';
import {UserIndexRepository} from '../../user/repositories/account/crud/UserIndexRepository';
import {UserSearchRepository} from '../../user/repositories/account/crud/UserSearchRepository';
import type {MigratedAccountClaimData} from '../../user/repositories/IUserAccountRepository';
import {createAuthHarness} from './AuthTestUtils';

const ID = createUserID(1400000000000000102n);
const DOB = types.LocalDate.fromString('2000-02-29');
const data = (email = 'synthetic-claim@example.com'): MigratedAccountClaimData => ({
	expiresAt: new Date(Date.now() + 15 * 60 * 1000),
	email,
	passwordHash: 'synthetic-hash-only-not-a-real-password',
	dateOfBirth: DOB,
	termsAgreedAt: new Date('2026-09-30T12:00:00Z'),
	privacyAgreedAt: new Date('2026-09-30T12:00:00Z'),
});

describe('Final migrated-account repository claim (trusted service inputs only)', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		await upsertOne(
			Users.upsertAll({
				...EMPTY_USER_ROW,
				user_id: ID,
				username: 'synthetic-migrant',
				discriminator: 0,
				traits: new Set(['discord_seed', `discord_id:${ID}`]),
				bio: 'preserve profile',
				version: 1,
			}),
		);
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('claims once, sets verified credentials and self-supplied DOB, and preserves identity/profile', async () => {
		const repo = getUserRepository();
		const user = await repo.claimMigratedAccount(ID, ID.toString(), data());
		expect(user.id).toBe(ID);
		expect(user.email).toBe('synthetic-claim@example.com');
		expect(user.emailVerified).toBe(true);
		expect(user.dateOfBirth?.toString()).toBe('2000-02-29');
		expect(user.passwordHash).toBe(data().passwordHash);
		expect(user.bio).toBe('preserve profile');
		expect(user.traits).toEqual(new Set(['discord_seed', `discord_id:${ID}`]));
		expect(user.acls.size).toBe(0);
		expect((await repo.findByEmail(user.email!))?.id).toBe(ID);
		await expect(repo.claimMigratedAccount(ID, ID.toString(), data('other@example.com'))).rejects.toBeInstanceOf(
			InvalidTokenError,
		);
	});

	it('does not replace a previously recorded DOB or legal consent dates', async () => {
		const originalDob = types.LocalDate.fromString('2001-01-01');
		const consent = new Date('2020-01-01T00:00:00Z');
		await upsertOne(
			Users.patchByPk({user_id: ID}, {date_of_birth: Db.set(originalDob), terms_agreed_at: Db.set(consent)}),
		);
		await expect(getUserRepository().claimMigratedAccount(ID, ID.toString(), data())).rejects.toBeInstanceOf(
			InvalidTokenError,
		);
		const user = await getUserRepository().claimMigratedAccount(ID, ID.toString(), {...data(), dateOfBirth: null});
		expect(user.dateOfBirth?.toString()).toBe('2001-01-01');
		expect(user.termsAgreedAt).toEqual(consent);
	});

	it('requires a birth date for a migrant that has no existing date', async () => {
		await expect(
			getUserRepository().claimMigratedAccount(ID, ID.toString(), {...data(), dateOfBirth: null}),
		).rejects.toBeInstanceOf(InvalidTokenError);
		expect((await getUserRepository().findUniqueAssert(ID)).email).toBeNull();
	});

	it('has only one winner among simultaneous final claims and never resolves losing emails to the account', async () => {
		const repo = getUserRepository();
		const results = await Promise.allSettled(
			Array.from({length: 10}, (_, i) =>
				repo.claimMigratedAccount(ID, ID.toString(), data(`synthetic-${i}@example.com`)),
			),
		);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(9);
		const winner = await repo.findUniqueAssert(ID);
		for (let i = 0; i < 10; i++) {
			expect((await repo.findByEmail(`synthetic-${i}@example.com`))?.id ?? null).toBe(
				winner.email === `synthetic-${i}@example.com` ? ID : null,
			);
		}
	});

	it('cannot remove the winning email ownership when competing claims share the same reservation', async () => {
		const repo = getUserRepository();
		const abort = vi.spyOn(UserEmailOwnershipRepository.prototype, 'abortEmailClaim');
		const results = await Promise.allSettled(
			Array.from({length: 10}, () => repo.claimMigratedAccount(ID, ID.toString(), data())),
		);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(9);
		expect(abort).not.toHaveBeenCalled();
		expect((await repo.findByEmail(data().email))?.id).toBe(ID);
	});

	it.each([
		{flags: UserFlags.STAFF},
		{acls: new Set(['*'])},
		{bot: true},
		{system: true},
		{password_hash: 'already-claimed'},
		{email: 'already-claimed@example.com'},
		{totp_secret: 'synthetic-totp-placeholder'},
		{authenticator_types: new Set([1])},
		{has_verified_phone: true},
		{pending_deletion_at: new Date()},
		{traits: new Set(['discord_seed', `discord_id:${ID}`, 'sso'])},
	] as Array<Partial<UserRow>>)('refuses ineligible account state %#', async (changes) => {
		const patch = Object.fromEntries(Object.entries(changes).map(([col, value]) => [col, Db.set(value)]));
		await upsertOne(Users.patchByPk({user_id: ID}, patch));
		await expect(getUserRepository().claimMigratedAccount(ID, ID.toString(), data())).rejects.toBeInstanceOf(
			InvalidTokenError,
		);
	});

	it('detects a privilege change between account read and commit even without changing version', async () => {
		const write = UserDataRepository.prototype.patchUserIf;
		const abort = vi.spyOn(UserEmailOwnershipRepository.prototype, 'abortEmailClaim');
		vi.spyOn(UserDataRepository.prototype, 'patchUserIf').mockImplementation(async function (
			this: UserDataRepository,
			...args
		) {
			await upsertOne(Users.patchByPk({user_id: ID}, {acls: Db.set(new Set(['*']))}));
			return write.apply(this, args);
		});
		await expect(getUserRepository().claimMigratedAccount(ID, ID.toString(), data())).rejects.toBeInstanceOf(
			InvalidTokenError,
		);
		expect(abort).not.toHaveBeenCalled();
		const user = await getUserRepository().findUniqueAssert(ID);
		expect(user.email).toBeNull();
		expect(user.acls).toEqual(new Set(['*']));
	});

	it('preserves an unrelated concurrent profile update and does not replay its old indexes', async () => {
		const write = UserDataRepository.prototype.patchUserIf;
		const allIndexes = vi.spyOn(UserIndexRepository.prototype, 'syncIndices');
		const emailIndex = vi.spyOn(UserIndexRepository.prototype, 'syncEmailIndex');
		const search = vi.spyOn(UserSearchRepository.prototype, 'updateUser');
		let raced = false;
		vi.spyOn(UserDataRepository.prototype, 'patchUserIf').mockImplementation(async function (
			this: UserDataRepository,
			...args
		) {
			if (!raced) {
				raced = true;
				await this.patchUser(ID, {username: Db.set('new-profile'), bio: Db.set('new bio')});
			}
			return write.apply(this, args);
		});
		const user = await getUserRepository().claimMigratedAccount(ID, ID.toString(), data());
		expect(user.username).toBe('new-profile');
		expect(user.bio).toBe('new bio');
		expect(user.version).toBe(3);
		expect(allIndexes).not.toHaveBeenCalled();
		expect(emailIndex).toHaveBeenCalledExactlyOnceWith(ID, data().email);
		expect(search).toHaveBeenCalledWith(user);
	});

	it('refuses a bounced-email state change without overwriting the newer value', async () => {
		const write = UserDataRepository.prototype.patchUserIf;
		vi.spyOn(UserDataRepository.prototype, 'patchUserIf').mockImplementation(async function (
			this: UserDataRepository,
			...args
		) {
			await upsertOne(Users.patchByPk({user_id: ID}, {email_bounced: Db.set(true)}));
			return write.apply(this, args);
		});
		await expect(getUserRepository().claimMigratedAccount(ID, ID.toString(), data())).rejects.toBeInstanceOf(
			InvalidTokenError,
		);
		const user = await getUserRepository().findUniqueAssert(ID);
		expect(user.email).toBeNull();
		expect(user.emailBounced).toBe(true);
	});

	it('does not abort a reservation when the database outcome is uncertain', async () => {
		const abort = vi.spyOn(UserEmailOwnershipRepository.prototype, 'abortEmailClaim');
		vi.spyOn(UserDataRepository.prototype, 'patchUserIf').mockRejectedValue(new Error('synthetic uncertain outcome'));
		await expect(getUserRepository().claimMigratedAccount(ID, ID.toString(), data())).rejects.toThrow(
			'synthetic uncertain outcome',
		);
		expect(abort).not.toHaveBeenCalled();
	});

	it('preserves and reconciles email ownership when the write committed but its reply was lost', async () => {
		const write = UserDataRepository.prototype.patchUserIf;
		const abort = vi.spyOn(UserEmailOwnershipRepository.prototype, 'abortEmailClaim');
		vi.spyOn(UserDataRepository.prototype, 'patchUserIf').mockImplementation(async function (
			this: UserDataRepository,
			...args
		) {
			expect(await write.apply(this, args)).toBe(true);
			throw new Error('synthetic lost commit reply');
		});
		await expect(getUserRepository().claimMigratedAccount(ID, ID.toString(), data())).rejects.toThrow(
			'synthetic lost commit reply',
		);
		expect(abort).not.toHaveBeenCalled();
		expect((await getUserRepository().findByEmail(data().email))?.id).toBe(ID);
		expect((await getUserRepository().findUniqueAssert(ID)).dateOfBirth?.toString()).toBe(DOB.toString());
	});

	it('never rolls back committed credentials if later index maintenance fails', async () => {
		const abort = vi.spyOn(UserEmailOwnershipRepository.prototype, 'abortEmailClaim');
		vi.spyOn(UserIndexRepository.prototype, 'syncEmailIndex').mockRejectedValue(
			new Error('synthetic post-commit failure'),
		);
		await expect(getUserRepository().claimMigratedAccount(ID, ID.toString(), data())).rejects.toThrow(
			'synthetic post-commit failure',
		);
		expect(abort).not.toHaveBeenCalled();
		const stored = await getUserRepository().findUniqueAssert(ID);
		expect(stored.email).toBe(data().email);
		expect(stored.passwordHash).toBe(data().passwordHash);
		expect(stored.dateOfBirth?.toString()).toBe(DOB.toString());
	});
});
