// SPDX-License-Identifier: AGPL-3.0-or-later

import {migrationTargetFingerprint} from '@fluxer/config/src/MigrationTargetFingerprint';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {
	MigrationClaimIssueResponse,
	MigrationClaimRedeemResponse,
} from '@fluxer/schema/src/domains/auth/MigrationClaimSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {AdminAuditService} from '../../admin/services/AdminAuditService';
import {createAdminApiKey} from '../../admin/tests/AdminTestUtils';
import {createUserID} from '../../BrandedTypes';
import {Config} from '../../Config';
import {createApiContext} from '../../CreateApiContext';
import {fetchMany, upsertOne} from '../../database/CassandraQueryExecution';
import {Db} from '../../database/CassandraTypes';
import {EMPTY_USER_ROW} from '../../database/types/UserTypes';
import {AdminAuditLogs, Users} from '../../Tables';
import type {ApiTestHarness} from '../../test/ApiTestHarness';
import {createBuilder} from '../../test/TestRequestBuilder';
import {MigrationClaimReadiness} from '../services/MigrationClaimPolicy';
import {MigrationClaimTicketService} from '../services/MigrationClaimTicketService';
import {
	createAuthHarness,
	createTestAccount,
	createTotpSecret,
	generateTotpCode,
	setUserACLs,
	type TestAccount,
} from './AuthTestUtils';

const ID = createUserID(1400000000000000102n);
const RUN = '09b9adba-70d0-41d9-9fc4-bb7b9f6a2e68';
const GUILD = '1400000000000000000';
const ISSUE = '/admin/migration/claims/issue';
const REVOKE = '/admin/migration/claims/revoke';

describe('Privileged migration ownership operations', () => {
	let harness: ApiTestHarness, admin: TestAccount, secret: string;
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
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.MIGRATION_CLAIM_MANAGE,
			AdminACLs.ADMIN_API_KEY_MANAGE,
		]);
		secret = createTotpSecret();
		await createBuilder(harness, admin.token)
			.post('/users/@me/mfa/totp/enable')
			.body({secret, code: generateTotpCode(secret), password: admin.password})
			.execute();
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
		const api = createApiContext(),
			setting = Config.auth.migrationClaim!;
		return new MigrationClaimTicketService(api.services.cache, api.services.users, {
			instanceFingerprint: setting.instanceFingerprint,
			migrationRunId: RUN,
			sourceGuildId: GUILD,
		});
	}
	function body(issue = true) {
		return {
			user_id: ID.toString(),
			...(issue ? {discord_user_id: ID.toString()} : {}),
			confirm: true,
			mfa_method: 'totp',
			mfa_code: generateTotpCode(secret),
		};
	}
	function post(
		path = ISSUE,
		data: unknown = body(path === ISSUE),
		token = admin.token,
		headers: Record<string, string> = {},
	) {
		return harness.requestJson({path, method: 'POST', body: data, headers: {Authorization: token, ...headers}});
	}
	async function auditActions() {
		return (await fetchMany(AdminAuditLogs.select().bind({}))).filter((row) =>
			String(row.action).startsWith('migration_claim_'),
		);
	}
	function privateHeaders(response: Response) {
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	}

	it('issues one exact-ID credential under MFA and records only sanitized request/success metadata', async () => {
		await enable();
		const response = await post();
		expect(response.status).toBe(200);
		privateHeaders(response);
		const issued = MigrationClaimIssueResponse.parse(await response.json());
		expect(issued.discord_user_id).toBe(ID.toString());
		expect(issued.token).toMatch(/^mc1\.[A-Za-z0-9_-]{43}$/);
		expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(900_000);
		const audit = await auditActions();
		expect(audit.map((row) => row.action).sort()).toEqual([
			'migration_claim_issue_requested',
			'migration_claim_issued',
		]);
		for (const row of audit) {
			expect(row.admin_user_id).toBe(BigInt(admin.userId));
			expect(row.target_id).toBe(ID);
			expect(row.audit_log_reason).toBeNull();
			expect(row.metadata).toEqual(
				new Map([
					['migration_run_id', RUN],
					['source_guild_id', GUILD],
					['discord_user_id', ID.toString()],
				]),
			);
		}
		expect(
			JSON.stringify(audit, (_key, value) =>
				typeof value === 'bigint' ? value.toString() : value instanceof Map ? [...value] : value,
			),
		).not.toContain(issued.token);
		expect((await tickets().consume(issued.token)).discordUserId).toBe(ID.toString());
	});

	it('default-disabled and missing readiness refuse issuance without publication or audit success', async () => {
		const issue = vi.spyOn(MigrationClaimTicketService.prototype, 'issue');
		expect((await post()).status).toBe(503);
		Config.auth.migrationClaim!.enabled = true;
		expect((await post()).status).toBe(503);
		expect(issue).not.toHaveBeenCalled();
		expect(await auditActions()).toEqual([]);
	});

	it.each([ISSUE, REVOKE])(
		'requires authenticated operator, dedicated ACL, enrolled MFA and explicit confirmation on %s',
		async (path) => {
			await enable();
			const data = body(path === ISSUE);
			expect((await post(path, data, '')).status).toBe(401);
			await upsertOne(
				Users.patchByPk(
					{user_id: createUserID(BigInt(admin.userId))},
					{acls: Db.set(new Set([AdminACLs.AUTHENTICATE]))},
				),
			);
			expect((await post(path, data)).status).toBe(403);
			await upsertOne(
				Users.patchByPk(
					{user_id: createUserID(BigInt(admin.userId))},
					{acls: Db.set(new Set([AdminACLs.AUTHENTICATE, AdminACLs.MIGRATION_CLAIM_MANAGE]))},
				),
			);
			expect((await post(path, {...data, confirm: false})).status).toBe(400);
			await upsertOne(
				Users.patchByPk(
					{user_id: createUserID(BigInt(admin.userId))},
					{authenticator_types: Db.set(new Set()), totp_secret: Db.set(null)},
				),
			);
			const noMfa = await post(path, data);
			expect(noMfa.status).toBe(400);
			privateHeaders(noMfa);
			expect(await auditActions()).toEqual([]);
		},
	);

	it('requires valid step-up rather than treating a password or missing MFA code as confirmation', async () => {
		await enable();
		const {mfa_method: _method, mfa_code: _code, ...data} = body();
		expect((await post(ISSUE, data)).status).toBe(403);
		expect((await post(ISSUE, {...data, password: admin.password})).status).toBe(400);
		expect((await post(ISSUE, {...body(), mfa_code: 'not-a-code'})).status).toBe(400);
		expect(await auditActions()).toEqual([]);
	});

	it('admin API keys cannot replace a human MFA-backed session', async () => {
		await enable();
		const key = await createAdminApiKey(
			harness,
			admin,
			'Synthetic migration key',
			[AdminACLs.MIGRATION_CLAIM_MANAGE],
			null,
		);
		expect((await post(ISSUE, body(), key.token)).status).toBe(403);
		expect((await post(REVOKE, body(false), key.token)).status).toBe(403);
		expect(await auditActions()).toEqual([]);
	});

	it('accepts recent MFA confirmation but still rechecks enrollment and explicit confirmation', async () => {
		await enable();
		const issued = await post();
		expect(issued.status).toBe(200);
		const confirmation = issued.headers.get('X-Fluxer-Sudo-Mode-JWT');
		expect(confirmation).toBeTruthy();
		const headers = {'X-Fluxer-Sudo-Mode-JWT': confirmation!};
		const data = {user_id: ID.toString(), confirm: true};
		expect((await post(REVOKE, {...data, confirm: false}, admin.token, headers)).status).toBe(400);
		expect((await post(REVOKE, data, admin.token, headers)).status).toBe(200);
		await upsertOne(
			Users.patchByPk(
				{user_id: createUserID(BigInt(admin.userId))},
				{authenticator_types: Db.set(new Set()), totp_secret: Db.set(null)},
			),
		);
		expect((await post(REVOKE, data, admin.token, headers)).status).toBe(400);
	});

	it('foreign identity and claimed/privileged recipients never produce a credential', async () => {
		await enable();
		expect((await post(ISSUE, {...body(), discord_user_id: '1400000000000000103'})).status).toBe(401);
		await upsertOne(Users.patchByPk({user_id: ID}, {password_hash: Db.set('synthetic claimed hash')}));
		expect((await post()).status).toBe(401);
		await upsertOne(
			Users.patchByPk({user_id: ID}, {password_hash: Db.set(null), acls: Db.set(new Set([AdminACLs.AUTHENTICATE]))}),
		);
		expect((await post()).status).toBe(401);
		expect((await auditActions()).some((row) => row.action === 'migration_claim_issued')).toBe(false);
	});

	it('revokes outstanding ownership and restricted proof generations even after deactivation, without mutating accounts', async () => {
		await enable();
		const issued = MigrationClaimIssueResponse.parse(await (await post()).json());
		const redeemed = await harness.requestJson({
			path: '/auth/migration/redeem',
			method: 'POST',
			body: {token: issued.token, confirm: true},
		});
		expect(redeemed.status).toBe(200);
		const proof = MigrationClaimRedeemResponse.parse(await redeemed.json());
		const before = await createApiContext().services.users.findUnique(ID);
		Config.auth.migrationClaim!.enabled = false;
		await upsertOne(MigrationClaimReadiness.deleteByPk({scope: 'active'}));
		const revoked = await post(REVOKE, body(false));
		expect(revoked.status).toBe(200);
		privateHeaders(revoked);
		expect(await revoked.json()).toEqual({revoked: true});
		await enable();
		const email = await harness.requestJson({
			path: '/auth/migration/email',
			method: 'POST',
			body: {proof: proof.proof, email: 'synthetic@example.invalid'},
		});
		expect(email.status).toBe(401);
		expect((await createApiContext().services.users.findUnique(ID))?.toRow()).toEqual(before?.toRow());
		expect((await auditActions()).map((row) => row.action)).toContain('migration_claim_revoked');
	});

	it.each(['ACL', 'MFA', 'disabled', 'readiness'] as const)(
		'rechecks operator/readiness after asynchronous auditing: %s removal refuses before publication',
		async (kind) => {
			await enable();
			const audit = AdminAuditService.prototype.createAuditLog;
			vi.spyOn(AdminAuditService.prototype, 'createAuditLog').mockImplementationOnce(async function (
				this: AdminAuditService,
				params,
			) {
				await audit.call(this, params);
				if (kind === 'readiness') await upsertOne(MigrationClaimReadiness.deleteByPk({scope: 'active'}));
				else
					await upsertOne(
						Users.patchByPk(
							{user_id: createUserID(BigInt(admin.userId))},
							kind === 'ACL'
								? {acls: Db.set(new Set())}
								: kind === 'MFA'
									? {authenticator_types: Db.set(new Set()), totp_secret: Db.set(null)}
									: {flags: Db.set(UserFlags.DISABLED)},
						),
					);
			});
			const issue = vi.spyOn(MigrationClaimTicketService.prototype, 'issue');
			expect((await post()).status).not.toBe(200);
			expect(issue).not.toHaveBeenCalled();
			expect((await auditActions()).map((row) => row.action)).toEqual(['migration_claim_issue_requested']);
		},
	);

	it('audit failure after ticket creation withholds the credential and revokes its generation', async () => {
		await enable();
		const issue = vi.spyOn(MigrationClaimTicketService.prototype, 'issue');
		const audit = AdminAuditService.prototype.createAuditLog;
		vi.spyOn(AdminAuditService.prototype, 'createAuditLog').mockImplementation(async function (
			this: AdminAuditService,
			params,
		) {
			if (params.action === 'migration_claim_issued') throw new Error('PRIVATE-provider-error mc1.PRIVATE');
			await audit.call(this, params);
		});
		const response = await post();
		expect(response.status).toBe(503);
		privateHeaders(response);
		expect(await response.text()).not.toContain('PRIVATE');
		const issued = await issue.mock.results[0]!.value;
		await expect(tickets().consume(issued.token)).rejects.toThrow();
		expect((await auditActions()).map((row) => row.action)).toEqual(['migration_claim_issue_requested']);
	});

	it('failed request audit prevents any issuance or revocation', async () => {
		await enable();
		vi.spyOn(AdminAuditService.prototype, 'createAuditLog').mockRejectedValue(new Error('PRIVATE-audit-error'));
		const issue = vi.spyOn(MigrationClaimTicketService.prototype, 'issue'),
			revoke = vi.spyOn(MigrationClaimTicketService.prototype, 'revoke');
		expect((await post()).status).toBe(503);
		expect((await post(REVOKE, body(false))).status).toBe(503);
		expect(issue).not.toHaveBeenCalled();
		expect(revoke).not.toHaveBeenCalled();
	});

	it.each(['publication', 'success audit'] as const)(
		'withholds and invalidates a credential when readiness disappears after %s',
		async (phase) => {
			await enable();
			const issue = MigrationClaimTicketService.prototype.issue;
			const issued = vi.spyOn(MigrationClaimTicketService.prototype, 'issue').mockImplementation(async function (
				this: MigrationClaimTicketService,
				userId,
				discordUserId,
			) {
				const ticket = await issue.call(this, userId, discordUserId);
				if (phase === 'publication') await upsertOne(MigrationClaimReadiness.deleteByPk({scope: 'active'}));
				return ticket;
			});
			if (phase === 'success audit') {
				const audit = AdminAuditService.prototype.createAuditLog;
				vi.spyOn(AdminAuditService.prototype, 'createAuditLog').mockImplementation(async function (
					this: AdminAuditService,
					params,
				) {
					await audit.call(this, params);
					if (params.action === 'migration_claim_issued')
						await upsertOne(MigrationClaimReadiness.deleteByPk({scope: 'active'}));
				});
			}
			const response = await post();
			expect(response.status).toBe(503);
			privateHeaders(response);
			const ticket = await issued.mock.results[0]!.value;
			expect(await response.text()).not.toContain(ticket.token);
			await expect(tickets().consume(ticket.token)).rejects.toThrow();
		},
	);

	it('a failed revocation success audit returns no success, although the credential stays revoked', async () => {
		await enable();
		const issued = MigrationClaimIssueResponse.parse(await (await post()).json());
		const audit = AdminAuditService.prototype.createAuditLog;
		vi.spyOn(AdminAuditService.prototype, 'createAuditLog').mockImplementation(async function (
			this: AdminAuditService,
			params,
		) {
			if (params.action === 'migration_claim_revoked') throw new Error('PRIVATE-audit-error');
			await audit.call(this, params);
		});
		const response = await post(REVOKE, body(false));
		expect(response.status).toBe(503);
		privateHeaders(response);
		expect(await response.text()).not.toContain('PRIVATE');
		await expect(tickets().consume(issued.token)).rejects.toThrow();
		expect((await auditActions()).some((row) => row.action === 'migration_claim_revoked')).toBe(false);
	});

	it('revocation refuses a mismatched target and detects a configured run change during auditing', async () => {
		await enable();
		const originalFingerprint = Config.auth.migrationClaim!.instanceFingerprint;
		Config.auth.migrationClaim!.instanceFingerprint = '0'.repeat(64);
		expect((await post(REVOKE, body(false))).status).toBe(503);
		expect(await auditActions()).toEqual([]);
		Config.auth.migrationClaim!.instanceFingerprint = originalFingerprint;
		const audit = AdminAuditService.prototype.createAuditLog;
		vi.spyOn(AdminAuditService.prototype, 'createAuditLog').mockImplementationOnce(async function (
			this: AdminAuditService,
			params,
		) {
			await audit.call(this, params);
			Config.auth.migrationClaim!.migrationRunId = 'e916fc04-d929-4788-819e-acb2a943ecdb';
		});
		const revoke = vi.spyOn(MigrationClaimTicketService.prototype, 'revoke');
		expect((await post(REVOKE, body(false))).status).toBe(503);
		expect(revoke).not.toHaveBeenCalled();
	});

	it.each([ISSUE, REVOKE])(
		'rejects query credentials, non-JSON bodies and client-selected context for %s',
		async (path) => {
			await enable();
			const data = body(path === ISSUE);
			for (const response of [
				await post(`${path}?token=PRIVATE`, data),
				await post(path, data, admin.token, {'content-type': 'text/plain'}),
				await post(path, {...data, migration_run_id: RUN}),
			]) {
				expect(response.status).toBe(400);
				privateHeaders(response);
				expect(await response.text()).not.toContain('PRIVATE');
			}
			expect(await auditActions()).toEqual([]);
		},
	);

	it.each([ISSUE, REVOKE])('GET/HEAD requests cannot mutate claim credentials on %s', async (path) => {
		await enable();
		const issue = vi.spyOn(MigrationClaimTicketService.prototype, 'issue');
		const revoke = vi.spyOn(MigrationClaimTicketService.prototype, 'revoke');
		for (const method of ['GET', 'HEAD']) {
			const response = await harness.requestJson({path, method, headers: {Authorization: admin.token}});
			expect(response.status).not.toBe(200);
		}
		expect(issue).not.toHaveBeenCalled();
		expect(revoke).not.toHaveBeenCalled();
		expect(await auditActions()).toEqual([]);
	});
});
