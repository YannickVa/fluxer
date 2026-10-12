// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	MigrationClaimCompleteRequest,
	MigrationClaimEmailRequest,
} from '@fluxer/schema/src/domains/auth/MigrationClaimSchemas';
import {
	type MigrationClaimClient,
	MigrationClaimClientError,
	type MigrationClaimFailureKind,
	type MigrationClaimFieldFailure,
} from './MigrationClaimClient';
import {isMigrationOwnershipToken, type MigrationClaimLink} from './MigrationClaimLink';

export interface MigrationClaimView {
	stage: 'confirm' | 'email' | 'complete' | 'finished' | 'stopped';
	busy: boolean;
	username?: string;
	dateOfBirthRequired?: boolean;
	expiresAt?: number;
	resendAvailableAt?: number;
	failure?: MigrationClaimFailureKind | 'uncertain' | 'expired' | 'missing' | 'unsafe_location';
	fieldFailures?: ReadonlyArray<MigrationClaimFieldFailure>;
}

export interface MigrationClaimCompletionInput {
	code: string;
	password: string;
	date_of_birth?: string;
	consent: boolean;
}

const privateFailure = (error: unknown): MigrationClaimClientError =>
	error instanceof MigrationClaimClientError ? error : new MigrationClaimClientError('unavailable');

/** No persistence or session integration. Credentials are private, non-serializable memory. */
export class MigrationClaimFlow {
	#token: string | undefined;
	#proof: string | undefined;
	#challenge: string | undefined;
	#challengeExpiresAt = 0;
	#view: MigrationClaimView;
	#abort = new AbortController();
	#revision = 0;

	constructor(
		link: MigrationClaimLink,
		private readonly api: MigrationClaimClient,
	) {
		if (link.status === 'ready' && isMigrationOwnershipToken(link.token)) {
			this.#token = link.token;
			this.#view = {stage: 'confirm', busy: false};
		} else {
			this.#view = {
				stage: 'stopped',
				busy: false,
				failure: link.status === 'ready' ? 'invalid_link' : link.status === 'invalid' ? 'invalid_link' : link.status,
			};
		}
	}

	get view(): MigrationClaimView {
		return {...this.#view, fieldFailures: this.#view.fieldFailures?.map((field) => ({...field}))};
	}

	/** Local deadline maintenance only; never polls the server. */
	refresh(): MigrationClaimView {
		this.live();
		return this.view;
	}

	changeEmail(): void {
		if (!this.live() || this.#view.busy || this.#view.stage !== 'complete') return;
		this.#challenge = undefined;
		this.#challengeExpiresAt = 0;
		this.#view = {...this.#view, stage: 'email', failure: undefined, fieldFailures: undefined};
	}

	/** Call on leaving/pagehide; a late response must never resurrect a disposed proof. */
	dispose(): void {
		this.stop('missing');
		this.#abort.abort();
	}

	private stop(failure: MigrationClaimView['failure']): void {
		this.#revision++;
		this.#token = this.#proof = this.#challenge = undefined;
		this.#challengeExpiresAt = 0;
		this.#view = {stage: 'stopped', busy: false, failure};
	}

	private live(): boolean {
		if (this.#abort.signal.aborted || this.#view.stage === 'stopped' || this.#view.stage === 'finished') return false;
		if (this.#view.expiresAt !== undefined && this.#view.expiresAt <= Date.now()) {
			this.stop('expired');
			return false;
		}
		return true;
	}

	async confirm(): Promise<void> {
		if (!this.live() || this.#view.busy || this.#view.stage !== 'confirm' || !this.#token) return;
		const token = this.#token;
		// A failed or lost response may already have consumed this ticket. Never replay it.
		this.#token = undefined;
		const revision = this.#revision;
		this.#view = {...this.#view, busy: true};
		try {
			const response = await this.api.redeem(token, this.#abort.signal);
			if (revision !== this.#revision) return;
			const expiresAt = Date.parse(response.expires_at);
			if (expiresAt <= Date.now()) {
				this.stop('expired');
				return;
			}
			this.#proof = response.proof;
			this.#view = {
				stage: 'email',
				busy: false,
				username: response.username,
				dateOfBirthRequired: response.date_of_birth_required,
				expiresAt,
			};
		} catch (error) {
			if (revision === this.#revision) this.stop(privateFailure(error).kind);
		}
	}

	async requestEmail(email: string): Promise<void> {
		if (!this.live() || this.#view.busy || !this.#proof || !['email', 'complete'].includes(this.#view.stage)) return;
		if ((this.#view.resendAvailableAt ?? 0) > Date.now()) return;
		const input = MigrationClaimEmailRequest.safeParse({proof: this.#proof, email});
		if (!input.success) {
			this.#view = {
				...this.#view,
				failure: 'invalid_form',
				fieldFailures: [{field: 'email', code: 'INVALID_EMAIL_ADDRESS'}],
			};
			return;
		}
		const revision = this.#revision;
		this.#challenge = undefined;
		this.#view = {...this.#view, stage: 'email', busy: true, failure: undefined, fieldFailures: undefined};
		try {
			const response = await this.api.email(input.data, this.#abort.signal);
			if (revision !== this.#revision || !this.live()) return;
			const expiresAt = Date.parse(response.expires_at);
			if (expiresAt > this.#view.expiresAt!) throw new MigrationClaimClientError('unavailable');
			this.#challengeExpiresAt = expiresAt;
			this.#challenge = response.challenge;
			this.#view = {...this.#view, stage: 'complete', resendAvailableAt: Date.parse(response.resend_available_at)};
		} catch (error) {
			if (revision !== this.#revision) return;
			const failure = privateFailure(error);
			if (failure.kind === 'invalid_link') this.stop('invalid_link');
			else this.#view = {...this.#view, failure: failure.kind, fieldFailures: failure.fields};
		} finally {
			if (revision === this.#revision) this.#view = {...this.#view, busy: false};
		}
	}

	async complete(values: MigrationClaimCompletionInput): Promise<void> {
		if (!this.live() || this.#view.busy || this.#view.stage !== 'complete' || !this.#proof || !this.#challenge) return;
		if (this.#challengeExpiresAt <= Date.now()) {
			this.#challenge = undefined;
			this.#view = {...this.#view, stage: 'email', failure: 'expired'};
			return;
		}
		const input = MigrationClaimCompleteRequest.safeParse({...values, proof: this.#proof, challenge: this.#challenge});
		if (!input.success || (this.#view.dateOfBirthRequired && !values.date_of_birth)) {
			this.#view = {
				...this.#view,
				failure: 'invalid_form',
				fieldFailures:
					this.#view.dateOfBirthRequired && !values.date_of_birth
						? [{field: 'date_of_birth', code: 'INVALID_DATE_OF_BIRTH_FORMAT'}]
						: [],
			};
			return;
		}
		const revision = this.#revision;
		this.#view = {...this.#view, busy: true, failure: undefined, fieldFailures: undefined};
		try {
			await this.api.complete(input.data, this.#abort.signal);
			if (revision !== this.#revision) return;
			this.#token = this.#proof = this.#challenge = undefined;
			this.#view = {stage: 'finished', busy: false};
		} catch (error) {
			if (revision !== this.#revision) return;
			const failure = privateFailure(error);
			if (failure.kind === 'invalid_form' || failure.kind === 'rate_limited')
				this.#view = {...this.#view, busy: false, failure: failure.kind, fieldFailures: failure.fields};
			else this.stop(failure.kind === 'invalid_link' ? 'invalid_link' : 'uncertain');
		}
	}
}
