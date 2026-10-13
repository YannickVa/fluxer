// SPDX-License-Identifier: AGPL-3.0-or-later

import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {
	type MigrationClaimCompleteRequest,
	MigrationClaimCompleteResponse,
	type MigrationClaimEmailRequest,
	MigrationClaimEmailResponse,
	MigrationClaimRedeemResponse,
} from '@fluxer/schema/src/domains/auth/MigrationClaimSchemas';
import {Endpoints} from '../../app/constants/Endpoints';

export type MigrationClaimFailureKind = 'invalid_link' | 'invalid_form' | 'rate_limited' | 'unavailable';
export type MigrationClaimField = 'email' | 'password' | 'code' | 'date_of_birth' | 'consent';
export interface MigrationClaimFieldFailure {
	field: MigrationClaimField;
	code: string;
}

const FIELDS = new Set<MigrationClaimField>(['email', 'password', 'code', 'date_of_birth', 'consent']);
const CODES = new Set<string>(Object.values(ValidationErrorCodes));

/** Only stable codes cross into rendering/logging; never provider text, bodies or causes. */
export class MigrationClaimClientError extends Error {
	constructor(
		readonly kind: MigrationClaimFailureKind,
		readonly fields: ReadonlyArray<MigrationClaimFieldFailure> = [],
	) {
		super('Migration claim request failed.');
		this.name = 'MigrationClaimClientError';
	}
}

export interface MigrationClaimTarget {
	apiEndpoint: string;
	apiVersion: number;
}

function targetBase(readTarget: () => MigrationClaimTarget): string {
	try {
		const target = readTarget();
		const url = new URL(target.apiEndpoint);
		const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
		if (
			(url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!Number.isSafeInteger(target.apiVersion) ||
			target.apiVersion < 1
		)
			throw new Error();
		return `${url.toString().replace(/\/+$/, '')}/v${target.apiVersion}`;
	} catch {
		throw new MigrationClaimClientError('unavailable');
	}
}

function formFailures(body: unknown): Array<MigrationClaimFieldFailure> {
	if (typeof body !== 'object' || body === null || !('errors' in body) || !Array.isArray(body.errors)) return [];
	const fields: Array<MigrationClaimFieldFailure> = [];
	for (const error of body.errors.slice(0, 32)) {
		if (typeof error !== 'object' || error === null) continue;
		const field = error.path;
		if (typeof field === 'string' && FIELDS.has(field as MigrationClaimField) && CODES.has(error.code))
			fields.push({field: field as MigrationClaimField, code: error.code});
	}
	return fields;
}

/** Isolated anonymous POST transport: no session, global interceptors, redirects or replay. */
export class MigrationClaimClient {
	readonly #base: string;

	constructor(
		private readonly target: () => MigrationClaimTarget,
		private readonly send: typeof fetch = globalThis.fetch.bind(globalThis),
	) {
		this.#base = targetBase(target);
	}

	private async post<T>(
		path: string,
		body: unknown,
		schema: {safeParse(value: unknown): {success: true; data: T} | {success: false}},
		signal: AbortSignal,
	): Promise<T> {
		if (targetBase(this.target) !== this.#base) throw new MigrationClaimClientError('unavailable');
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener('abort', abort, {once: true});
		if (signal.aborted) controller.abort();
		const timeout = setTimeout(abort, 15_000);
		try {
			if (controller.signal.aborted) throw new MigrationClaimClientError('unavailable');
			const response = await this.send(`${this.#base}${path}`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', Accept: 'application/json'},
				body: JSON.stringify(body),
				credentials: 'omit',
				cache: 'no-store',
				redirect: 'error',
				referrerPolicy: 'no-referrer',
				signal: controller.signal,
			});
			if (response.redirected) throw new MigrationClaimClientError('unavailable');
			if (!response.ok) {
				if (response.status === 401) throw new MigrationClaimClientError('invalid_link');
				if (response.status === 429) throw new MigrationClaimClientError('rate_limited');
				if (response.status === 400) {
					let data: unknown;
					try {
						data = await response.json();
					} catch {
						data = null;
					}
					throw new MigrationClaimClientError('invalid_form', formFailures(data));
				}
				throw new MigrationClaimClientError('unavailable');
			}
			const parsed = schema.safeParse(await response.json());
			if (!parsed.success) throw new MigrationClaimClientError('unavailable');
			return parsed.data;
		} catch (error) {
			if (error instanceof MigrationClaimClientError) throw error;
			throw new MigrationClaimClientError('unavailable');
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener('abort', abort);
		}
	}

	redeem(token: string, signal: AbortSignal): Promise<MigrationClaimRedeemResponse> {
		return this.post(Endpoints.AUTH_MIGRATION_REDEEM, {token, confirm: true}, MigrationClaimRedeemResponse, signal);
	}

	email(body: MigrationClaimEmailRequest, signal: AbortSignal): Promise<MigrationClaimEmailResponse> {
		return this.post(Endpoints.AUTH_MIGRATION_EMAIL, body, MigrationClaimEmailResponse, signal);
	}

	complete(body: MigrationClaimCompleteRequest, signal: AbortSignal): Promise<MigrationClaimCompleteResponse> {
		return this.post(Endpoints.AUTH_MIGRATION_COMPLETE, body, MigrationClaimCompleteResponse, signal);
	}
}
