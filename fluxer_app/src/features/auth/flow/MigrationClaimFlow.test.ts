// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, describe, expect, it, vi} from 'vitest';
import {MigrationClaimClient, MigrationClaimClientError} from './MigrationClaimClient';
import {MigrationClaimFlow} from './MigrationClaimFlow';

const TOKEN = `mc1.${'A'.repeat(43)}`;
const PROOF = `mp1.${'A'.repeat(43)}`;
const CHALLENGE = `me1.${'A'.repeat(43)}`;
const completeInput = {
	code: 'synthetic-code',
	password: 'Synthetic password! 492',
	date_of_birth: '1998-03-11',
	consent: true,
};

function response(path: string): Response {
	if (path.endsWith('/redeem'))
		return Response.json({
			proof: PROOF,
			expires_at: new Date(Date.now() + 900_000).toISOString(),
			username: 'synthetic-migrant',
			date_of_birth_required: true,
		});
	if (path.endsWith('/email'))
		return Response.json({
			challenge: CHALLENGE,
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			resend_available_at: new Date(Date.now() + 30_000).toISOString(),
		});
	return Response.json({user_id: '1400000000000000102', login_required: true});
}

function fixture() {
	const target = {apiEndpoint: 'https://synthetic.example.invalid/api', apiVersion: 1};
	const send = vi.fn<typeof fetch>(async (url) => response(String(url)));
	const api = new MigrationClaimClient(() => target, send);
	const flow = new MigrationClaimFlow({status: 'ready', token: TOKEN}, api);
	return {target, send, api, flow};
}

async function claimedEmail() {
	const f = fixture();
	await f.flow.confirm();
	await f.flow.requestEmail('synthetic@example.invalid');
	return f;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('Isolated migration claim transport', () => {
	it('local deadline refresh clears expired credentials without making a request', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {flow, send} = await claimedEmail();
		vi.setSystemTime(Date.now() + 900_001);
		expect(flow.refresh()).toMatchObject({stage: 'stopped', failure: 'expired'});
		await flow.complete(completeInput);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('changing email discards the old challenge and retains the resend cooldown', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {flow, send} = await claimedEmail();
		flow.changeEmail();
		expect(flow.view.stage).toBe('email');
		await flow.complete(completeInput);
		await flow.requestEmail('other@example.invalid');
		expect(send).toHaveBeenCalledTimes(2);
		vi.setSystemTime(Date.now() + 31_000);
		await flow.requestEmail('other@example.invalid');
		expect(flow.view.stage).toBe('complete');
		expect(send).toHaveBeenCalledTimes(3);
	});
	it('uses fixed anonymous JSON POSTs, never auth headers, URL credentials, redirects, cache or replay', async () => {
		const {send, flow} = await claimedEmail();
		await flow.complete(completeInput);
		expect(send).toHaveBeenCalledTimes(3);
		for (const [url, options] of send.mock.calls) {
			expect(url).toMatch(/^https:\/\/synthetic\.example\.invalid\/api\/v1\/auth\/migration\/(redeem|email|complete)$/);
			expect(options).toMatchObject({
				method: 'POST',
				credentials: 'omit',
				redirect: 'error',
				cache: 'no-store',
				referrerPolicy: 'no-referrer',
			});
			expect(options!.headers).toEqual({'Content-Type': 'application/json', Accept: 'application/json'});
		}
		expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toEqual({token: TOKEN, confirm: true});
		expect(flow.view).toMatchObject({stage: 'finished', busy: false});
		expect(JSON.stringify(flow)).not.toContain(TOKEN);
		expect(JSON.stringify(flow)).not.toContain(PROOF);
		expect(JSON.stringify(flow)).not.toContain(CHALLENGE);
	});

	it.each([
		'http://external.example.invalid/api',
		'https://user:PRIVATE@example.invalid/api',
		'https://example.invalid/api?token=PRIVATE',
		'https://example.invalid/api#PRIVATE',
	])('refuses unsafe API targets without exposing %s', (apiEndpoint) => {
		expect(() => new MigrationClaimClient(() => ({apiEndpoint, apiVersion: 1}))).toThrow(
			'Migration claim request failed.',
		);
	});

	it('allows loopback HTTP for disposable local tests, never arbitrary insecure hosts', () => {
		for (const host of ['localhost', '127.0.0.1', '[::1]'])
			expect(
				() => new MigrationClaimClient(() => ({apiEndpoint: `http://${host}:1234/api`, apiVersion: 1})),
			).not.toThrow();
	});

	it('refuses a changed instance before sending a credential', async () => {
		const {flow, target, send} = fixture();
		target.apiEndpoint = 'https://other.example.invalid/api';
		await flow.confirm();
		expect(send).not.toHaveBeenCalled();
		expect(flow.view).toMatchObject({stage: 'stopped', failure: 'unavailable'});
	});

	it('drops provider text, parser details, unknown field paths and unknown codes', async () => {
		const {flow, send} = fixture();
		await flow.confirm();
		send.mockResolvedValueOnce(
			Response.json(
				{
					message: `PRIVATE ${PROOF}`,
					errors: [
						{path: 'email', code: 'EMAIL_ALREADY_IN_USE', message: 'PRIVATE-address'},
						{path: 'PRIVATE-path', code: 'INVALID_EMAIL_ADDRESS'},
						{path: 'password', code: 'PRIVATE-code'},
					],
				},
				{status: 400},
			),
		);
		await flow.requestEmail('synthetic@example.invalid');
		expect(flow.view.fieldFailures).toEqual([{field: 'email', code: 'EMAIL_ALREADY_IN_USE'}]);
		expect(JSON.stringify(flow.view)).not.toContain('PRIVATE');
	});

	it.each([401, 429, 503, 502])(
		'sanitizes failure status %s and never retries a one-time redemption',
		async (status) => {
			const {flow, send} = fixture();
			send.mockResolvedValueOnce(new Response(`PRIVATE ${TOKEN}`, {status}));
			await flow.confirm();
			await flow.confirm();
			expect(send).toHaveBeenCalledTimes(1);
			expect(flow.view.stage).toBe('stopped');
			expect(JSON.stringify(flow.view)).not.toContain('PRIVATE');
		},
	);

	it('sanitizes malformed successful response bodies without leaking proof material', async () => {
		const {api, send} = fixture();
		send.mockResolvedValueOnce(Response.json({proof: `PRIVATE ${PROOF}`}));
		try {
			await api.redeem(TOKEN, new AbortController().signal);
			throw new Error('Expected refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(MigrationClaimClientError);
			expect(JSON.stringify(error)).not.toContain(PROOF);
			expect(String(error)).not.toContain('PRIVATE');
		}
	});

	it('times out without automatically retrying or exposing the native error', async () => {
		vi.useFakeTimers();
		const {flow, send} = fixture();
		send.mockImplementationOnce(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					options!.signal!.addEventListener('abort', () => reject(new Error(`PRIVATE ${TOKEN}`)));
				}),
		);
		const pending = flow.confirm();
		await vi.advanceTimersByTimeAsync(15_000);
		await pending;
		expect(send).toHaveBeenCalledTimes(1);
		expect(flow.view).toMatchObject({stage: 'stopped', busy: false, failure: 'unavailable'});
	});
});

describe('Memory-only claim lifecycle', () => {
	it('requires an explicit action; construction, missing links and repeated clicks make no accidental request', async () => {
		const {api, send, flow} = fixture();
		expect(flow.view.stage).toBe('confirm');
		expect(send).not.toHaveBeenCalled();
		for (const status of ['missing', 'invalid', 'unsafe_location'] as const) {
			const invalid = new MigrationClaimFlow({status}, api);
			await invalid.confirm();
			expect(invalid.view.stage).toBe('stopped');
		}
		await Promise.all([flow.confirm(), flow.confirm()]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(flow.view.stage).toBe('email');
	});

	it('neither serializes nor exposes ownership/proof/challenge credentials in any view', async () => {
		const {flow} = fixture();
		for (const action of [async () => {}, () => flow.confirm(), () => flow.requestEmail('synthetic@example.invalid')]) {
			await action();
			for (const token of [TOKEN, PROOF, CHALLENGE]) {
				expect(JSON.stringify(flow)).not.toContain(token);
				expect(JSON.stringify(flow.view)).not.toContain(token);
			}
		}
	});

	it('drops all credentials on disposal and ignores a late response', async () => {
		const {flow, send} = fixture();
		let release!: (value: Response) => void;
		send.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const pending = flow.confirm();
		flow.dispose();
		release(response('/redeem'));
		await pending;
		expect(flow.view).toMatchObject({stage: 'stopped', failure: 'missing'});
		await flow.requestEmail('synthetic@example.invalid');
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('enforces resend cooldown without network polling, and updates challenges only on explicit resend', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {flow, send} = await claimedEmail();
		await flow.requestEmail('other@example.invalid');
		expect(send).toHaveBeenCalledTimes(2);
		vi.setSystemTime(Date.now() + 31_000);
		await flow.requestEmail('other@example.invalid');
		expect(send).toHaveBeenCalledTimes(3);
		expect(JSON.parse(send.mock.calls[2]![1]!.body as string)).toEqual({proof: PROOF, email: 'other@example.invalid'});
	});

	it('validation failures allow correction but server failure after completion becomes an uncertain outcome, never an automatic retry', async () => {
		const {flow, send} = await claimedEmail();
		send.mockResolvedValueOnce(
			Response.json({errors: [{path: 'code', code: 'INVALID_VERIFICATION_CODE'}]}, {status: 400}),
		);
		await flow.complete(completeInput);
		expect(flow.view).toMatchObject({stage: 'complete', busy: false, failure: 'invalid_form'});
		send.mockRejectedValueOnce(new Error(`PRIVATE ${PROOF}`));
		await flow.complete(completeInput);
		expect(flow.view).toMatchObject({stage: 'stopped', busy: false, failure: 'uncertain'});
		await flow.complete(completeInput);
		expect(send).toHaveBeenCalledTimes(4);
	});

	it('requires user-provided birth date when requested, never guesses or saves one', async () => {
		const {flow, send} = await claimedEmail();
		const {date_of_birth: _birthDate, ...values} = completeInput;
		await flow.complete(values);
		expect(flow.view).toMatchObject({stage: 'complete', failure: 'invalid_form'});
		expect(send).toHaveBeenCalledTimes(2);
		await flow.complete(completeInput);
		expect(flow.view.stage).toBe('finished');
		expect(JSON.stringify(flow)).not.toContain(completeInput.date_of_birth);
	});

	it('expired email codes return to email while expired ownership clears the entire workflow', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const {flow, send} = await claimedEmail();
		vi.setSystemTime(Date.now() + 61_000);
		await flow.complete(completeInput);
		expect(flow.view).toMatchObject({stage: 'email', failure: 'expired'});
		expect(send).toHaveBeenCalledTimes(2);
		vi.setSystemTime(Date.now() + 900_000);
		await flow.requestEmail('synthetic@example.invalid');
		expect(flow.view).toMatchObject({stage: 'stopped', failure: 'expired'});
		expect(send).toHaveBeenCalledTimes(2);
	});
});
