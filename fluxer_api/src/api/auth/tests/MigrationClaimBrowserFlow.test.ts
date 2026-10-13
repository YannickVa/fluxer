// SPDX-License-Identifier: AGPL-3.0-or-later

import {migrationTargetFingerprint} from '@fluxer/config/src/MigrationTargetFingerprint';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MigrationClaimClient} from '../../../../../fluxer_app/src/features/auth/flow/MigrationClaimClient';
import {MigrationClaimFlow} from '../../../../../fluxer_app/src/features/auth/flow/MigrationClaimFlow';
import {createUserID} from '../../BrandedTypes';
import {Config} from '../../Config';
import {createApiContext} from '../../CreateApiContext';
import {fetchMany, upsertOne} from '../../database/CassandraQueryExecution';
import {Db} from '../../database/CassandraTypes';
import {EMPTY_USER_ROW} from '../../database/types/UserTypes';
import {getInstanceConfigRepository} from '../../middleware/ServiceSingletons';
import {AuthSessions, Users} from '../../Tables';
import type {ApiTestHarness} from '../../test/ApiTestHarness';
import * as AuthPassword from '../AuthPassword';
import {MigrationClaimReadiness} from '../services/MigrationClaimPolicy';
import {MigrationClaimTicketService} from '../services/MigrationClaimTicketService';
import {createAuthHarness, findLastTestEmail, listTestEmails} from './AuthTestUtils';

const ID = createUserID(1400000000000000102n);
const RUN = '09b9adba-70d0-41d9-9fc4-bb7b9f6a2e68';
const GUILD = '1400000000000000000';
const EMAIL = 'synthetic-browser-claim@example.com';
const PASSWORD = 'Synthetic browser claim password! 492';

describe('Client workflow against actual claim HTTP handlers', () => {
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
			enabled: true,
			instanceFingerprint: migrationTargetFingerprint(Config),
			migrationRunId: RUN,
			sourceGuildId: GUILD,
		};
		await upsertOne(
			MigrationClaimReadiness.upsertAll({
				scope: 'active',
				instance_fingerprint: Config.auth.migrationClaim.instanceFingerprint,
				migration_run_id: RUN,
				source_guild_id: GUILD,
				state: 'ready',
				verified_at: new Date(),
			}),
		);
		await upsertOne(
			Users.upsertAll({
				...EMPTY_USER_ROW,
				user_id: ID,
				username: 'synthetic-migrant',
				discriminator: 0,
				bio: 'Preserved migration profile',
				traits: new Set(['discord_seed', `discord_id:${ID}`]),
				version: 1,
			}),
		);
		const api = createApiContext();
		vi.spyOn(getInstanceConfigRepository(), 'isEmailEnabled').mockResolvedValue(true);
		vi.spyOn(api.services.emailDnsValidation, 'hasValidDnsRecords').mockResolvedValue(true);
		vi.spyOn(AuthPassword, 'isPasswordPwned').mockResolvedValue(false);
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

	function tickets() {
		const api = createApiContext();
		return new MigrationClaimTicketService(api.services.cache, api.services.users, {
			instanceFingerprint: Config.auth.migrationClaim!.instanceFingerprint,
			migrationRunId: RUN,
			sourceGuildId: GUILD,
		});
	}

	async function setupFlow(loseCompletionResponse = false) {
		const mail = vi.spyOn(createApiContext().services.email, 'sendEmailChangeNew').mockResolvedValue(true);
		const ticket = await tickets().issue(ID, ID.toString());
		const send = vi.fn<typeof fetch>(async (input, init) => {
			const url = new URL(String(input));
			expect(url.origin).toBe('https://synthetic.example.invalid');
			expect(url.search + url.hash).toBe('');
			expect(init).toMatchObject({
				method: 'POST',
				credentials: 'omit',
				redirect: 'error',
				cache: 'no-store',
				referrerPolicy: 'no-referrer',
			});
			const headers = Object.fromEntries(new Headers(init!.headers).entries());
			expect(headers).not.toHaveProperty('authorization');
			const reply = await harness.requestJson({
				path: url.pathname.replace(/^\/api\/v1/, ''),
				method: init!.method,
				headers,
				body: JSON.parse(init!.body as string),
			});
			if (loseCompletionResponse && url.pathname.endsWith('/complete') && reply.ok)
				throw new Error('PRIVATE lost response after account write');
			return reply;
		});
		const flow = new MigrationClaimFlow(
			{status: 'ready', token: ticket.token},
			new MigrationClaimClient(() => ({apiEndpoint: 'https://synthetic.example.invalid/api', apiVersion: 1}), send),
		);
		return {flow, send, mail};
	}

	it('corrects a code typo, completes with the real password/DOB write and never creates a login session', async () => {
		const {flow, mail, send} = await setupFlow();
		expect(send).not.toHaveBeenCalled();
		await flow.confirm();
		expect(flow.view).toMatchObject({stage: 'email', username: 'synthetic-migrant', dateOfBirthRequired: true});
		await flow.requestEmail(EMAIL);
		expect(flow.view.stage).toBe('complete');
		const data = {code: 'wrong-synthetic-code', password: PASSWORD, date_of_birth: '2000-02-29', consent: true};
		await flow.complete(data);
		expect(flow.view).toMatchObject({
			stage: 'complete',
			failure: 'invalid_form',
			fieldFailures: [{field: 'code', code: 'INVALID_VERIFICATION_CODE'}],
		});
		expect((await createApiContext().services.users.findUniqueAssert(ID)).passwordHash).toBeNull();
		await flow.complete({...data, code: mail.mock.calls[0]![2]});
		expect(flow.view).toMatchObject({stage: 'finished', busy: false});
		const user = await createApiContext().services.users.findUniqueAssert(ID);
		expect(user.email).toBe(EMAIL);
		expect(user.emailVerified).toBe(true);
		expect(user.bio).toBe('Preserved migration profile');
		expect(user.dateOfBirth?.toString()).toBe('2000-02-29');
		expect(
			await AuthPassword.verifyPassword(createApiContext(), {password: PASSWORD, passwordHash: user.passwordHash!}),
		).toBe(true);
		expect(await fetchMany(AuthSessions.select().bind({}))).toEqual([]);
	});

	it('stops a revoked/reissued ownership generation without saving email or password', async () => {
		const {flow} = await setupFlow();
		await flow.confirm();
		await tickets().issue(ID, ID.toString());
		await flow.requestEmail(EMAIL);
		expect(flow.view).toMatchObject({stage: 'stopped', failure: 'invalid_link'});
		const user = await createApiContext().services.users.findUniqueAssert(ID);
		expect(user.email).toBeNull();
		expect(user.passwordHash).toBeNull();
	});

	it('readiness lost during hashing refuses the actual account write and becomes an uncertain client outcome', async () => {
		const {flow, mail, send} = await setupFlow();
		await flow.confirm();
		await flow.requestEmail(EMAIL);
		vi.spyOn(AuthPassword, 'hashPassword').mockImplementation(async () => {
			await upsertOne(MigrationClaimReadiness.patchByPk({scope: 'active'}, {state: Db.set('preparing')}));
			return 'synthetic-hash';
		});
		await flow.complete({code: mail.mock.calls[0]![2], password: PASSWORD, date_of_birth: '2000-02-29', consent: true});
		expect(flow.view).toMatchObject({stage: 'stopped', failure: 'uncertain'});
		await flow.complete({code: 'synthetic', password: PASSWORD, consent: true});
		expect(send).toHaveBeenCalledTimes(3);
		expect((await createApiContext().services.users.findUniqueAssert(ID)).passwordHash).toBeNull();
	});

	it('lost success response is not silently replayed; the committed account remains usable via normal login', async () => {
		const {flow, mail, send} = await setupFlow(true);
		await flow.confirm();
		await flow.requestEmail(EMAIL);
		const values = {code: mail.mock.calls[0]![2], password: PASSWORD, date_of_birth: '2000-02-29', consent: true};
		await flow.complete(values);
		expect(flow.view).toMatchObject({stage: 'stopped', failure: 'uncertain'});
		expect(JSON.stringify(flow.view)).not.toContain('PRIVATE');
		await flow.complete(values);
		expect(send).toHaveBeenCalledTimes(3);
		const user = await createApiContext().services.users.findUniqueAssert(ID);
		expect(user.emailVerified).toBe(true);
		expect(
			await AuthPassword.verifyPassword(createApiContext(), {password: PASSWORD, passwordHash: user.passwordHash!}),
		).toBe(true);
		expect(await fetchMany(AuthSessions.select().bind({}))).toEqual([]);
		const login = () =>
			harness.requestJson({path: '/auth/login', method: 'POST', body: {email: EMAIL, password: PASSWORD}});
		const firstLogin = await login();
		expect(firstLogin.status).toBe(403);
		expect(await firstLogin.json()).toMatchObject({code: 'IP_AUTHORIZATION_REQUIRED'});
		const authorization = findLastTestEmail(await listTestEmails(harness, {recipient: EMAIL}), 'ip_authorization');
		expect(authorization).not.toBeNull();
		const verified = await harness.requestJson({
			path: '/auth/authorize-ip',
			method: 'POST',
			body: {token: authorization!.metadata['token']},
		});
		expect(verified.status).toBe(204);
		const signedIn = await login();
		expect(signedIn.status).toBe(200);
		expect(await signedIn.json()).toMatchObject({user_id: ID.toString(), token: expect.stringMatching(/^flx_/)});
	});
});
