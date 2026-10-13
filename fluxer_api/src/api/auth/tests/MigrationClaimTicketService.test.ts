// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {InvalidTokenError} from '@fluxer/errors/src/domains/core/InvalidTokenError';
import {safeJsonParse} from '@pkgs/cache/src/CacheSerialization';
import {InMemoryProvider} from '@pkgs/cache/src/providers/InMemoryProvider';
import {KVCacheProvider} from '@pkgs/cache/src/providers/KVCacheProvider';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createUserID, type UserID} from '../../BrandedTypes';
import {EMPTY_USER_ROW, type UserRow} from '../../database/types/UserTypes';
import {User} from '../../models/User';
import {MockKVProvider} from '../../test/mocks/MockKVProvider';
import {type MigrationClaimContext, MigrationClaimTicketService} from '../services/MigrationClaimTicketService';

const USER_ID = createUserID(1400000000000000102n);
const CONTEXT: MigrationClaimContext = {
	instanceFingerprint: 'a'.repeat(64),
	migrationRunId: '09b9adba-70d0-41d9-9fc4-bb7b9f6a2e68',
	sourceGuildId: '1400000000000000000',
};

function account(overrides: Partial<UserRow> = {}) {
	return new User({
		...EMPTY_USER_ROW,
		user_id: USER_ID,
		username: 'migration-fixture',
		discriminator: 0,
		traits: new Set(['discord_seed', `discord_id:${USER_ID}`]),
		version: 1,
		...overrides,
	});
}

function fixture() {
	const cache = new InMemoryProvider();
	const users = {findUnique: vi.fn(async (_id: UserID): Promise<User | null> => account())};
	const service = new MigrationClaimTicketService(cache, users, CONTEXT);
	return {cache, users, service};
}

afterEach(() => vi.useRealTimers());

describe('Migrated-account ownership tickets', () => {
	it('issues unique 256-bit credentials and stores only hash-keyed metadata with a short expiry', async () => {
		const {cache, service} = fixture();
		const set = vi.spyOn(cache, 'set');
		const result = await service.issue(USER_ID, USER_ID.toString());
		expect(result.token).toMatch(/^mc1\.[A-Za-z0-9_-]{43}$/);
		expect(result.discordUserId).toBe(USER_ID.toString());
		expect(result.expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
		expect(set.mock.calls).toHaveLength(2);
		expect(set.mock.calls.every((call) => call[2] === 900)).toBe(true);
		expect(JSON.stringify(set.mock.calls)).not.toContain(result.token);
		const second = await service.issue(USER_ID, USER_ID.toString());
		expect(second.token).not.toBe(result.token);
	});

	it('consumes exactly once and returns the bound identity, not an auth session', async () => {
		const {service} = fixture();
		const issued = await service.issue(USER_ID, USER_ID.toString());
		const proof = await service.consume(issued.token);
		expect(proof.user.id).toBe(USER_ID);
		expect(proof.discordUserId).toBe(USER_ID.toString());
		expect(proof.context).toEqual(CONTEXT);
		expect(proof.expiresAt).toEqual(issued.expiresAt);
		expect(proof).not.toHaveProperty('token');
		await expect(service.consume(issued.token)).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('allows only one winner across simultaneous consumption attempts', async () => {
		const {service} = fixture();
		const issued = await service.issue(USER_ID, USER_ID.toString());
		const results = await Promise.allSettled(Array.from({length: 20}, () => service.consume(issued.token)));
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(19);
	});

	it('matches production GETDEL atomicity and does not return expired memory-cache values', async () => {
		const cache = new InMemoryProvider();
		await cache.set('one-time-fixture', {value: true}, 900);
		const results = await Promise.all(Array.from({length: 20}, () => cache.getAndDelete('one-time-fixture')));
		expect(results.filter((value) => value !== null)).toHaveLength(1);
		vi.useFakeTimers();
		await cache.set('expired-fixture', true, 1);
		vi.advanceTimersByTime(1000);
		expect(await cache.getAndDelete('expired-fixture')).toBeNull();
	});

	it('reissue supersedes older links and account revocation invalidates unredeemed tickets', async () => {
		const {service} = fixture();
		const first = await service.issue(USER_ID, USER_ID.toString());
		const second = await service.issue(USER_ID, USER_ID.toString());
		await expect(service.consume(first.token)).rejects.toBeInstanceOf(InvalidTokenError);
		await expect(service.consume(second.token)).resolves.toHaveProperty('discordUserId', USER_ID.toString());
		const third = await service.issue(USER_ID, USER_ID.toString());
		await service.revoke(USER_ID);
		await expect(service.consume(third.token)).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('is isolated across instances, migration generations and source communities', async () => {
		const {service, cache, users} = fixture();
		const issued = await service.issue(USER_ID, USER_ID.toString());
		for (const context of [
			{...CONTEXT, instanceFingerprint: 'b'.repeat(64)},
			{...CONTEXT, migrationRunId: '19b9adba-70d0-41d9-9fc4-bb7b9f6a2e68'},
			{...CONTEXT, sourceGuildId: '1400000000000000001'},
		]) {
			await expect(new MigrationClaimTicketService(cache, users, context).consume(issued.token)).rejects.toBeInstanceOf(
				InvalidTokenError,
			);
		}
		await expect(service.consume(issued.token)).resolves.toHaveProperty('discordUserId', USER_ID.toString());
	});

	it('rejects malformed and noncanonical tokens before accessing the cache without echoing inputs', async () => {
		const {cache, service} = fixture();
		const read = vi.spyOn(cache, 'getAndDelete');
		for (const token of ['', 'private-secret', `mc1.${'A'.repeat(42)}`, `mc1.${'A'.repeat(42)}B`, 'x'.repeat(1000)]) {
			await expect(service.consume(token)).rejects.toBeInstanceOf(InvalidTokenError);
		}
		expect(read).not.toHaveBeenCalled();
	});

	it('refuses foreign, privileged, bot, claimed, disabled and ambiguous accounts before issuing credentials', async () => {
		for (const override of [
			{email: 'synthetic@example.invalid'},
			{password_hash: 'synthetic-hash'},
			{bot: true},
			{system: true},
			{acls: new Set(['*'])},
			{flags: UserFlags.STAFF},
			{flags: UserFlags.STAFF_HIDDEN},
			{flags: UserFlags.DISABLED},
			{flags: UserFlags.DELETED},
			{flags: UserFlags.RATE_LIMIT_BYPASS},
			{flags: UserFlags.APP_STORE_REVIEWER},
			{flags: UserFlags.LIMIT_EXEMPT},
			{totp_secret: 'synthetic'},
			{authenticator_types: new Set([1])},
			{has_verified_phone: true},
			{suspicious_activity_flags: 1},
			{flags: 1n << 35n},
			{pending_deletion_at: new Date()},
			{temp_banned_until: new Date(Date.now() + 60_000)},
			{traits: new Set(['discord_seed'])},
			{traits: new Set([`discord_id:${USER_ID}`])},
			{traits: new Set(['discord_seed', `discord_id:${USER_ID}`, 'sso'])},
			{traits: new Set(['discord_seed', `discord_id:${USER_ID}`, 'webhook_ghost'])},
			{traits: new Set(['discord_seed', `discord_id:${USER_ID}`, 'discord_id:1400000000000000103'])},
		] satisfies Array<Partial<UserRow>>) {
			const {service, users, cache} = fixture();
			users.findUnique.mockResolvedValue(account(override));
			const set = vi.spyOn(cache, 'set');
			await expect(service.issue(USER_ID, USER_ID.toString())).rejects.toBeInstanceOf(InvalidTokenError);
			expect(set).not.toHaveBeenCalled();
		}
	});

	it('rechecks account eligibility on consumption, and never restores a rejected ticket', async () => {
		const {service, users} = fixture();
		const issued = await service.issue(USER_ID, USER_ID.toString());
		users.findUnique.mockResolvedValue(account({password_hash: 'synthetic-now-claimed'}));
		await expect(service.consume(issued.token)).rejects.toBeInstanceOf(InvalidTokenError);
		users.findUnique.mockResolvedValue(account());
		await expect(service.consume(issued.token)).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('rechecks revocation after an asynchronous account lookup', async () => {
		const {service, users} = fixture();
		const issued = await service.issue(USER_ID, USER_ID.toString());
		users.findUnique.mockImplementation(async () => {
			await service.revoke(USER_ID);
			return account();
		});
		await expect(service.consume(issued.token)).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('enforces absolute expiry independently of cache retention', async () => {
		const {service, cache} = fixture();
		vi.useFakeTimers();
		const issued = await service.issue(USER_ID, USER_ID.toString());
		const key = `migration-claim:${CONTEXT.instanceFingerprint}:${CONTEXT.migrationRunId}:${CONTEXT.sourceGuildId}`;
		const set = vi.spyOn(cache, 'set');
		// Issue another ticket to inspect its hash-keyed, serialized-equivalent metadata.
		const result = await service.issue(USER_ID, USER_ID.toString());
		const record = structuredClone(set.mock.calls[0]![1]);
		const tokenKey = set.mock.calls[0]![0];
		const activeHash = set.mock.calls[1]![1];
		vi.advanceTimersByTime(900_000);
		await cache.set(tokenKey, record, 900);
		await cache.set(`${key}:account:${USER_ID}`, activeHash, 900);
		await expect(service.consume(result.token)).rejects.toBeInstanceOf(InvalidTokenError);
		await expect(service.consume(issued.token)).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('rejects invalid trusted context without leaking its contents', () => {
		const {cache, users} = fixture();
		expect(
			() => new MigrationClaimTicketService(cache, users, {...CONTEXT, instanceFingerprint: 'private-config'}),
		).toThrow('values omitted');
	});

	it('malformed cached auth data does not expose payloads or native parser text in logs', () => {
		const logger = {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()};
		const raw = '{"token":"synthetic-private-credential",';
		expect(safeJsonParse(raw, logger)).toBeNull();
		expect(logger.error).toHaveBeenCalledOnce();
		expect(JSON.stringify(logger.error.mock.calls)).not.toContain('synthetic-private-credential');
		expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Unexpected');
	});

	it('the production cache adapter uses atomic KV GETDEL and serialized records for concurrent claims', async () => {
		const client = new MockKVProvider();
		const cache = new KVCacheProvider({client});
		const users = {findUnique: async (_id: UserID) => account()};
		const service = new MigrationClaimTicketService(cache, users, CONTEXT);
		const issued = await service.issue(USER_ID, USER_ID.toString());
		const results = await Promise.allSettled(Array.from({length: 20}, () => service.consume(issued.token)));
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(client.getdelSpy).toHaveBeenCalledTimes(20);
		expect(JSON.stringify(client.setexSpy.mock.calls)).not.toContain(issued.token);
	});

	it('malformed, foreign-context or excessively long-lived cached records are consumed but never accepted', async () => {
		for (const mutation of [
			{version: 2},
			{userId: 'not-an-id'},
			{discordUserId: '1400000000000000103'},
			{context: {...CONTEXT, sourceGuildId: '1400000000000000001'}},
			{issuedAt: Date.now() + 10_000, expiresAt: Date.now() + 20_000},
			{expiresAt: Date.now() + 3600_000},
		]) {
			const {service, cache} = fixture();
			const set = vi.spyOn(cache, 'set');
			const issued = await service.issue(USER_ID, USER_ID.toString());
			const key = set.mock.calls[0]![0];
			const original = structuredClone(set.mock.calls[0]![1]);
			await cache.set(key, {...(original as object), ...mutation}, 900);
			await expect(service.consume(issued.token)).rejects.toBeInstanceOf(InvalidTokenError);
			expect(await cache.get(key)).toBeNull();
		}
	});

	it('missing/wrong users and Discord mapping changes refuse both issuance and consumption', async () => {
		for (const wrong of [null, account({user_id: createUserID(1400000000000000103n)})]) {
			const {service, users} = fixture();
			const issued = await service.issue(USER_ID, USER_ID.toString());
			users.findUnique.mockResolvedValue(wrong);
			await expect(service.issue(USER_ID, USER_ID.toString())).rejects.toBeInstanceOf(InvalidTokenError);
			await expect(service.consume(issued.token)).rejects.toBeInstanceOf(InvalidTokenError);
		}
		const {service} = fixture();
		await expect(service.issue(USER_ID, '1400000000000000103')).rejects.toBeInstanceOf(InvalidTokenError);
		await expect(service.issue(USER_ID, '0')).rejects.toBeInstanceOf(InvalidTokenError);
		await expect(service.issue(USER_ID, '18446744073709551616')).rejects.toBeInstanceOf(InvalidTokenError);
	});

	it('backend failures do not turn a consumed credential into a reusable one', async () => {
		const {service, users} = fixture();
		const issued = await service.issue(USER_ID, USER_ID.toString());
		users.findUnique.mockRejectedValueOnce(new Error('Synthetic account store unavailable'));
		await expect(service.consume(issued.token)).rejects.toThrow('Synthetic account store unavailable');
		await expect(service.consume(issued.token)).rejects.toBeInstanceOf(InvalidTokenError);
	});
});
