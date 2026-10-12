// SPDX-License-Identifier: AGPL-3.0-or-later

import {migrationTargetFingerprint} from '@fluxer/config/src/MigrationTargetFingerprint';
import {
	MigrationClaimEmailResponse,
	MigrationClaimRedeemResponse,
} from '@fluxer/schema/src/domains/auth/MigrationClaimSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createUserID} from '../../BrandedTypes';
import {Config} from '../../Config';
import {createApiContext} from '../../CreateApiContext';
import {fetchMany, upsertOne} from '../../database/CassandraQueryExecution';
import {Db} from '../../database/CassandraTypes';
import {EMPTY_USER_ROW} from '../../database/types/UserTypes';
import {getInstanceConfigRepository} from '../../middleware/ServiceSingletons';
import {AuthSessions, Users} from '../../Tables';
import type {ApiTestHarness} from '../../test/ApiTestHarness';
import {UserEmailOwnershipRepository} from '../../user/repositories/account/crud/UserEmailOwnershipRepository';
import * as AuthPassword from '../AuthPassword';
import {MigrationClaimCompletionService} from '../services/MigrationClaimCompletionService';
import {MigrationClaimReadiness} from '../services/MigrationClaimPolicy';
import {MigrationClaimTicketService} from '../services/MigrationClaimTicketService';
import {createAuthHarness} from './AuthTestUtils';

const responseLog = vi.hoisted(() => ({error: vi.fn()}));
const claimLog = vi.hoisted(() => ({error: vi.fn()}));
vi.mock('@fluxer/logger/src/Logger', async (importOriginal) => {
	const original = await importOriginal<typeof import('@fluxer/logger/src/Logger')>();
	return {
		...original,
		createLogger: (name: string, ...args: Array<unknown>) =>
			name === 'response_validation'
				? responseLog
				: name === 'migration_claim'
					? claimLog
					: original.createLogger(name, ...(args as [])),
	};
});

const ID = createUserID(1400000000000000102n);
const RUN = '09b9adba-70d0-41d9-9fc4-bb7b9f6a2e68';
const GUILD = '1400000000000000000';
const paths = ['/auth/migration/redeem', '/auth/migration/email', '/auth/migration/complete'];

describe('Guarded migration claim HTTP endpoints', () => {
	let harness: ApiTestHarness;
	const originalSetting = Config.auth.migrationClaim;
	const originalBackend = Config.database.backend;
	const originalSelfHosted = Config.instance.selfHosted;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		Config.database.backend = 'postgres';
		Config.instance.selfHosted = true;
		Config.auth.migrationClaim = {
			enabled: false,
			instanceFingerprint: migrationTargetFingerprint(Config),
			migrationRunId: RUN,
			sourceGuildId: GUILD,
		};
		responseLog.error.mockClear();
		claimLog.error.mockClear();
		await upsertOne(
			Users.upsertAll({
				...EMPTY_USER_ROW,
				user_id: ID,
				username: 'synthetic-migrant',
				discriminator: 0,
				traits: new Set(['discord_seed', `discord_id:${ID}`]),
				version: 1,
			}),
		);
	});
	afterEach(() => {
		Config.auth.migrationClaim = originalSetting;
		Config.database.backend = originalBackend;
		Config.instance.selfHosted = originalSelfHosted;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function enable() {
		Config.auth.migrationClaim!.enabled = true;
		await upsertOne(
			MigrationClaimReadiness.upsertAll({
				scope: 'active',
				instance_fingerprint: Config.auth.migrationClaim!.instanceFingerprint,
				migration_run_id: RUN,
				source_guild_id: GUILD,
				state: 'ready',
				verified_at: new Date(),
			}),
		);
	}
	function tickets() {
		const setting = Config.auth.migrationClaim!;
		const api = createApiContext();
		return new MigrationClaimTicketService(api.services.cache, api.services.users, {
			instanceFingerprint: setting.instanceFingerprint,
			migrationRunId: setting.migrationRunId,
			sourceGuildId: setting.sourceGuildId,
		});
	}
	async function post(path: string, body: unknown, headers?: Record<string, string>) {
		return harness.requestJson({path, body, method: 'POST', headers});
	}

	it.each(paths)('refuses %s when disabled, without accepting credentials', async (path) => {
		const response = await post(path, {});
		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	});

	it('does not consume a ticket when the database readiness binding is missing', async () => {
		Config.auth.migrationClaim!.enabled = true;
		const issued = await tickets().issue(ID, ID.toString());
		expect((await post(paths[0]!, {token: issued.token, confirm: true})).status).toBe(503);
		await enable();
		expect((await post(paths[0]!, {token: issued.token, confirm: true})).status).toBe(200);
	});

	it.each([
		'instance_fingerprint',
		'migration_run_id',
		'source_guild_id',
		'state',
		'verified_at',
	] as const)('refuses a mismatched or invalid database readiness field %s', async (field) => {
		await enable();
		const value =
			field === 'state' ? 'preparing' : field === 'verified_at' ? new Date(Date.now() + 60_000) : 'mismatched';
		await upsertOne(MigrationClaimReadiness.patchByPk({scope: 'active'}, {[field]: Db.set(value)} as never));
		expect((await post(paths[0]!, {token: `mc1.${'A'.repeat(43)}`, confirm: true})).status).toBe(503);
	});

	it('recomputes the effective storage fingerprint instead of trusting a configured digest', async () => {
		await enable();
		Config.auth.migrationClaim!.instanceFingerprint = 'b'.repeat(64);
		await upsertOne(
			MigrationClaimReadiness.patchByPk({scope: 'active'}, {instance_fingerprint: Db.set('b'.repeat(64))}),
		);
		expect((await post(paths[0]!, {token: `mc1.${'A'.repeat(43)}`, confirm: true})).status).toBe(503);
	});

	it('does not publish private migration context in the public discovery document', async () => {
		await enable();
		const response = await harness.requestJson({path: '/.well-known/fluxer'});
		expect(response.status).toBe(200);
		const body = await response.text();
		for (const privateValue of [Config.auth.migrationClaim!.instanceFingerprint, RUN, GUILD, 'migrationClaim'])
			expect(body).not.toContain(privateValue);
	});

	it.each(['hosted', 'cassandra', 'bad-context'] as const)('refuses unsupported server context %s', async (kind) => {
		await enable();
		if (kind === 'hosted') Config.instance.selfHosted = false;
		if (kind === 'cassandra') Config.database.backend = 'cassandra';
		if (kind === 'bad-context') Config.auth.migrationClaim!.sourceGuildId = 'not-an-id';
		expect((await post(paths[0]!, {token: `mc1.${'A'.repeat(43)}`, confirm: true})).status).toBe(503);
	});

	it('GET, HEAD, missing confirmation and query credentials never consume a link', async () => {
		await enable();
		const issued = await tickets().issue(ID, ID.toString());
		for (const method of ['GET', 'HEAD'])
			expect((await harness.requestJson({path: paths[0]!, method})).status).toBe(404);
		expect((await post(paths[0]!, {token: issued.token})).status).toBe(400);
		expect((await post(`${paths[0]}?token=${issued.token}`, {token: issued.token, confirm: true})).status).toBe(400);
		expect((await post(paths[0]!, {token: issued.token, confirm: true}, {'content-type': 'text/plain'})).status).toBe(
			400,
		);
		expect((await post(paths[0]!, {token: issued.token, confirm: true})).status).toBe(200);
		expect((await post(paths[0]!, {token: issued.token, confirm: true})).status).toBe(401);
	});

	it('rejects client-selected identities and run context without leaking supplied values', async () => {
		await enable();
		const issued = await tickets().issue(ID, ID.toString());
		const response = await post(paths[0]!, {
			token: issued.token,
			confirm: true,
			user_id: 'private-synthetic-value',
			context: {migrationRunId: 'private-run'},
		});
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain('private-synthetic-value');
		expect((await post(paths[0]!, {token: issued.token, confirm: true})).status).toBe(200);
	});

	it.each(paths)('rate-limits anonymous submissions to %s before credential lookup', async (path) => {
		await enable();
		const headers = {'x-fluxer-test-enable-rate-limits': 'true'};
		const count = path.endsWith('/email') ? 5 : 10;
		for (let i = 0; i < count; i++) expect((await post(path, {}, headers)).status).toBe(400);
		const response = await post(path, {}, headers);
		expect(response.status).toBe(429);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('completes through all three HTTP endpoints without creating a normal auth session', async () => {
		await enable();
		const api = createApiContext();
		vi.spyOn(getInstanceConfigRepository(), 'isEmailEnabled').mockResolvedValue(true);
		vi.spyOn(api.services.emailDnsValidation, 'hasValidDnsRecords').mockResolvedValue(true);
		vi.spyOn(AuthPassword, 'isPasswordPwned').mockResolvedValue(false);
		const mail = vi.spyOn(api.services.email, 'sendEmailChangeNew').mockResolvedValue(true);
		const issued = await tickets().issue(ID, ID.toString());
		const redeemed = await post(paths[0]!, {token: issued.token, confirm: true});
		expect(redeemed.status).toBe(200);
		const {proof} = MigrationClaimRedeemResponse.parse(await redeemed.json());
		const email = await post(paths[1]!, {proof, email: 'synthetic-http@example.com'});
		expect(email.status).toBe(200);
		const {challenge} = MigrationClaimEmailResponse.parse(await email.json());
		const completed = await post(paths[2]!, {
			proof,
			challenge,
			code: mail.mock.calls[0]![2],
			password: 'Synthetic-HTTP-password-72',
			date_of_birth: '2000-01-01',
			consent: true,
		});
		expect(completed.status).toBe(200);
		expect(await completed.json()).toEqual({user_id: ID.toString(), login_required: true});
		expect(await fetchMany(AuthSessions.select().bind({}))).toEqual([]);
	});

	it('revalidates readiness after asynchronous hashing and refuses a stopped migration', async () => {
		await enable();
		const api = createApiContext();
		vi.spyOn(getInstanceConfigRepository(), 'isEmailEnabled').mockResolvedValue(true);
		vi.spyOn(api.services.emailDnsValidation, 'hasValidDnsRecords').mockResolvedValue(true);
		vi.spyOn(AuthPassword, 'isPasswordPwned').mockResolvedValue(false);
		const mail = vi.spyOn(api.services.email, 'sendEmailChangeNew').mockResolvedValue(true);
		const issued = await tickets().issue(ID, ID.toString());
		const {proof} = MigrationClaimRedeemResponse.parse(
			await (await post(paths[0]!, {token: issued.token, confirm: true})).json(),
		);
		const {challenge} = MigrationClaimEmailResponse.parse(
			await (await post(paths[1]!, {proof, email: 'synthetic-stop@example.com'})).json(),
		);
		vi.spyOn(AuthPassword, 'hashPassword').mockImplementation(async () => {
			await upsertOne(MigrationClaimReadiness.patchByPk({scope: 'active'}, {state: Db.set('preparing')}));
			return 'synthetic-hash';
		});
		expect(
			(
				await post(paths[2]!, {
					proof,
					challenge,
					code: mail.mock.calls[0]![2],
					password: 'Synthetic-stop-password-72',
					date_of_birth: '2000-01-01',
					consent: true,
				})
			).status,
		).toBe(503);
		expect((await api.services.users.findUniqueAssert(ID)).passwordHash).toBeNull();
	});

	it('redacts credential-bearing response bodies on schema validation failures', async () => {
		await enable();
		const secret = `mp1.${'A'.repeat(43)}`;
		vi.spyOn(MigrationClaimCompletionService.prototype, 'redeem').mockResolvedValue({
			proof: secret,
			expires_at: 'invalid',
			username: 'synthetic',
			date_of_birth_required: true,
		});
		const response = await post(paths[0]!, {token: `mc1.${'A'.repeat(43)}`, confirm: true});
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain(secret);
		expect(responseLog.error).toHaveBeenCalled();
		expect(JSON.stringify(responseLog.error.mock.calls)).not.toContain(secret);
		expect(responseLog.error.mock.calls[0]![0]).toHaveProperty('body', '[redacted]');
	});

	it('revalidates readiness after reserving the email, before the guarded account write', async () => {
		await enable();
		const api = createApiContext();
		vi.spyOn(getInstanceConfigRepository(), 'isEmailEnabled').mockResolvedValue(true);
		vi.spyOn(api.services.emailDnsValidation, 'hasValidDnsRecords').mockResolvedValue(true);
		vi.spyOn(AuthPassword, 'isPasswordPwned').mockResolvedValue(false);
		const mail = vi.spyOn(api.services.email, 'sendEmailChangeNew').mockResolvedValue(true);
		const issued = await tickets().issue(ID, ID.toString());
		const {proof} = MigrationClaimRedeemResponse.parse(
			await (await post(paths[0]!, {token: issued.token, confirm: true})).json(),
		);
		const {challenge} = MigrationClaimEmailResponse.parse(
			await (await post(paths[1]!, {proof, email: 'synthetic-reservation@example.com'})).json(),
		);
		const reserve = UserEmailOwnershipRepository.prototype.claimEmail;
		vi.spyOn(UserEmailOwnershipRepository.prototype, 'claimEmail').mockImplementation(async function (
			this: UserEmailOwnershipRepository,
			...args
		) {
			const result = await reserve.apply(this, args);
			await upsertOne(MigrationClaimReadiness.patchByPk({scope: 'active'}, {state: Db.set('preparing')}));
			return result;
		});
		expect(
			(
				await post(paths[2]!, {
					proof,
					challenge,
					code: mail.mock.calls[0]![2],
					password: 'Synthetic-reservation-password-72',
					date_of_birth: '2000-01-01',
					consent: true,
				})
			).status,
		).toBe(503);
		expect((await api.services.users.findUniqueAssert(ID)).passwordHash).toBeNull();
	});

	it('omits unexpected provider error contents from logs and HTTP errors', async () => {
		await enable();
		vi.spyOn(MigrationClaimCompletionService.prototype, 'redeem').mockRejectedValue(
			new Error('synthetic-private-provider-content'),
		);
		const response = await post(paths[0]!, {token: `mc1.${'A'.repeat(43)}`, confirm: true});
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain('synthetic-private-provider-content');
		expect(claimLog.error).toHaveBeenCalled();
		expect(JSON.stringify(claimLog.error.mock.calls)).not.toContain('synthetic-private-provider-content');
	});
});
