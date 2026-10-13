// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {InvalidTokenError} from '@fluxer/errors/src/domains/core/InvalidTokenError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {requireClientIp} from '@fluxer/ip_utils/src/ClientIp';
import {
	MigrationClaimCompleteRequest,
	type MigrationClaimCompleteResponse,
	MigrationClaimEmailRequest,
	type MigrationClaimEmailResponse,
	MigrationClaimRedeemRequest,
	type MigrationClaimRedeemResponse,
} from '@fluxer/schema/src/domains/auth/MigrationClaimSchemas';
import {EmailType} from '@fluxer/schema/src/primitives/UserValidators';
import {z} from 'zod';
import type {ApiContext} from '../../ApiContext';
import {createUserID} from '../../BrandedTypes';
import {isBlockedEmailDomain} from '../../infrastructure/activity/SharedLists';
import type {InstanceConfigRepository} from '../../instance/InstanceConfigRepository';
import {assertMigrationClaimEligible} from '../../user/MigrationAccountEligibility';
import {checkChangeRateLimit, generateChangeVerificationCode} from '../../user/services/UserChangeChallengeUtils';
import {extractEmailDomain} from '../../utils/EmailDomainUtils';
import {lookupGeoip} from '../../utils/IpUtils';
import * as AuthPassword from '../AuthPassword';
import {validateDateOfBirth} from '../AuthUtility';
import {assertEmailNotBlocklisted} from '../EmailBlocklist';
import {
	hashMigrationClaimToken,
	type MigrationClaimContext,
	MigrationClaimContextSchema,
	MigrationClaimIdSchema,
	MigrationClaimTicketService,
} from './MigrationClaimTicketService';

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const ProofSchema = z
	.object({
		version: z.literal(1),
		context: MigrationClaimContextSchema,
		userId: MigrationClaimIdSchema,
		discordUserId: MigrationClaimIdSchema,
		ticketHash: Hash,
		issuedAt: z.number().int().nonnegative(),
		expiresAt: z.number().int().positive(),
	})
	.strict();
const ChallengeSchema = z
	.object({
		version: z.literal(1),
		proofHash: Hash,
		userId: MigrationClaimIdSchema,
		email: EmailType,
		codeHash: Hash,
		expiresAt: z.number().int().positive(),
	})
	.strict();
type Proof = z.infer<typeof ProofSchema>;
type Challenge = z.infer<typeof ChallengeSchema>;

interface ClaimDependencies {
	/** Public entry points must revalidate the trusted run after asynchronous gates. */
	authorize?: () => Promise<void>;
	instance: Pick<InstanceConfigRepository, 'getAppPublicConfig' | 'isEmailEnabled'>;
	accountPolicy: {getMinimumAgeForRegion(countryCode: string | null, fallback: number): number};
}

function credential(kind: 'mp1' | 'me1') {
	return `${kind}.${randomBytes(32).toString('base64url')}`;
}

function codeHash(challengeHash: string, code: string) {
	return createHash('sha256').update(`${challengeHash}:${code.trim().toUpperCase()}`).digest('hex');
}

/** Restricted workflow only: no session minting and no general user self-update. */
export class MigrationClaimCompletionService {
	private readonly tickets: MigrationClaimTicketService;
	private readonly context: MigrationClaimContext;
	private readonly prefix: string;

	constructor(
		private readonly api: ApiContext,
		private readonly deps: ClaimDependencies,
		context: MigrationClaimContext,
	) {
		this.tickets = new MigrationClaimTicketService(api.services.cache, api.services.users, context);
		this.context = {...context};
		this.prefix = `migration-completion:${context.instanceFingerprint}:${context.migrationRunId}:${context.sourceGuildId}`;
	}

	async redeem(input: MigrationClaimRedeemRequest): Promise<MigrationClaimRedeemResponse> {
		const data = MigrationClaimRedeemRequest.parse(input);
		await this.deps.authorize?.();
		const accepted = await this.tickets.consume(data.token);
		const proof = credential('mp1');
		const record: Proof = {
			version: 1,
			context: accepted.context,
			userId: accepted.user.id.toString(),
			discordUserId: accepted.discordUserId,
			ticketHash: hashMigrationClaimToken(data.token),
			issuedAt: Date.now(),
			expiresAt: accepted.expiresAt.getTime(),
		};
		await this.assertLive(record);
		await this.api.services.cache.set(
			this.proofKey(hashMigrationClaimToken(proof, 'mp1')),
			record,
			this.ttl(record.expiresAt),
		);
		await this.assertLive(record);
		return {
			proof,
			expires_at: accepted.expiresAt.toISOString(),
			username: accepted.user.username,
			date_of_birth_required: accepted.user.dateOfBirth === null,
		};
	}

	async requestEmail(input: MigrationClaimEmailRequest): Promise<MigrationClaimEmailResponse> {
		const data = MigrationClaimEmailRequest.parse(input);
		const {proof, hash, user} = await this.loadProof(data.proof);
		await this.limit(proof.userId, 'email', 5, 900_000);
		await this.limit(proof.userId, 'email-cooldown', 1, 30_000);
		if (!(await this.deps.instance.isEmailEnabled())) throw new ServiceUnavailableError();
		const email = data.email.trim().toLowerCase();
		await this.assertEmailAllowed(email);
		if (!(await this.api.services.emailDnsValidation.hasValidDnsRecords(email)))
			throw InputValidationError.fromCode('email', ValidationErrorCodes.INVALID_EMAIL_ADDRESS);
		const existing = await this.api.services.users.findByEmail(email);
		if (existing && existing.id !== user.id)
			throw InputValidationError.fromCode('email', ValidationErrorCodes.EMAIL_ALREADY_IN_USE);
		await this.loadProof(data.proof);
		const challenge = credential('me1');
		const challengeHash = hashMigrationClaimToken(challenge, 'me1');
		const code = generateChangeVerificationCode();
		const expiresAt = Math.min(proof.expiresAt, Date.now() + 600_000);
		const record: Challenge = {
			version: 1,
			proofHash: hash,
			userId: proof.userId,
			email,
			codeHash: codeHash(challengeHash, code),
			expiresAt,
		};
		await this.api.services.cache.set(this.challengeKey(challengeHash), record, this.ttl(expiresAt));
		if (!(await this.api.services.email.sendEmailChangeNew(email, user.username, code, user.locale)))
			throw new ServiceUnavailableError();
		await this.loadProof(data.proof);
		this.ttl(expiresAt);
		// Publish last; immutable challenge records never rewrite or resurrect a proof.
		await this.api.services.cache.set(this.emailPointer(hash), challengeHash, this.ttl(proof.expiresAt));
		await this.loadProof(data.proof);
		this.ttl(expiresAt);
		return {
			challenge,
			expires_at: new Date(expiresAt).toISOString(),
			resend_available_at: new Date(Date.now() + 30_000).toISOString(),
		};
	}

	async complete(input: MigrationClaimCompleteRequest, request: Request): Promise<MigrationClaimCompleteResponse> {
		const data = MigrationClaimCompleteRequest.parse(input);
		const {proof, hash, user} = await this.loadProof(data.proof);
		await this.limit(proof.userId, 'complete', 10, 900_000);
		const challengeHash = hashMigrationClaimToken(data.challenge, 'me1');
		const challenge = await this.readChallenge(challengeHash, proof, hash, data.code);
		const {countryCode} = await lookupGeoip(
			requireClientIp(request, {
				trustClientIpHeader: this.api.services.config.proxy.trust_client_ip_header,
				clientIpHeaderName: this.api.services.config.proxy.client_ip_header,
			}),
		);
		const dob = data.date_of_birth ?? user.dateOfBirth?.toString() ?? '';
		const dateOfBirth = validateDateOfBirth(this.api, {
			dateOfBirth: dob,
			minAge: this.deps.accountPolicy.getMinimumAgeForRegion(countryCode, 13),
		});
		if (user.dateOfBirth && dateOfBirth.toString() !== user.dateOfBirth.toString()) throw new InvalidTokenError();
		const config = await this.deps.instance.getAppPublicConfig();
		const termsRequired = !this.api.services.config.instance.selfHosted || config.legal.terms_url !== null;
		const privacyRequired = !this.api.services.config.instance.selfHosted || config.legal.privacy_url !== null;
		if ((termsRequired || privacyRequired) && !data.consent)
			throw InputValidationError.fromCode('consent', ValidationErrorCodes.MUST_AGREE_TO_TOS_AND_PRIVACY_POLICY);
		if (await AuthPassword.isPasswordPwned(this.api, data.password))
			throw InputValidationError.fromCode('password', ValidationErrorCodes.PASSWORD_IS_TOO_COMMON);
		const passwordHash = await AuthPassword.hashPassword(this.api, data.password);
		await this.assertEmailAllowed(challenge.email);
		// Recheck every asynchronous gate before the irreversible single-use boundary.
		await this.loadProof(data.proof);
		await this.readChallenge(challengeHash, proof, hash, data.code);
		const consumed = await this.api.services.cache.getAndDelete<unknown>(this.proofKey(hash));
		const parsedProof = ProofSchema.safeParse(consumed);
		if (!parsedProof.success || !isDeepStrictEqual(parsedProof.data, proof)) throw new InvalidTokenError();
		const consumedChallenge = await this.api.services.cache.getAndDelete<unknown>(this.challengeKey(challengeHash));
		const parsedChallenge = ChallengeSchema.safeParse(consumedChallenge);
		if (!parsedChallenge.success || !isDeepStrictEqual(parsedChallenge.data, challenge)) throw new InvalidTokenError();
		await this.assertLive(proof);
		if ((await this.api.services.cache.get(this.emailPointer(hash))) !== challengeHash) throw new InvalidTokenError();
		this.ttl(challenge.expiresAt);
		await this.deps.authorize?.();
		const now = new Date();
		const claimed = await this.api.services.users
			.claimMigratedAccount(user.id, proof.discordUserId, {
				authorize: this.deps.authorize,
				expiresAt: new Date(Math.min(proof.expiresAt, challenge.expiresAt)),
				email: challenge.email,
				passwordHash,
				dateOfBirth,
				termsAgreedAt: termsRequired ? now : null,
				privacyAgreedAt: privacyRequired ? now : null,
			})
			.catch((error: unknown) => {
				// Credentials are already consumed; a late email conflict cannot be retried
				// with this proof. Send the terminal claim error instead of a form error.
				if (error instanceof InputValidationError) throw new InvalidTokenError();
				throw error;
			});
		return {user_id: claimed.id.toString(), login_required: true};
	}

	private proofKey(hash: string) {
		return `${this.prefix}:proof:${hash}`;
	}

	private async assertEmailAllowed(email: string): Promise<void> {
		if (isBlockedEmailDomain(extractEmailDomain(email)))
			throw InputValidationError.fromCode('email', ValidationErrorCodes.INVALID_EMAIL_ADDRESS);
		await assertEmailNotBlocklisted(email, 'email');
	}
	private challengeKey(hash: string) {
		return `${this.prefix}:email:${hash}`;
	}
	private emailPointer(hash: string) {
		return `${this.prefix}:email-current:${hash}`;
	}

	private ttl(expiresAt: number) {
		const remaining = expiresAt - Date.now();
		if (remaining <= 0) throw new InvalidTokenError();
		return Math.ceil(remaining / 1000);
	}

	private async assertLive(proof: Proof) {
		await this.deps.authorize?.();
		if (
			proof.context.instanceFingerprint !== this.context.instanceFingerprint ||
			proof.context.migrationRunId !== this.context.migrationRunId ||
			proof.context.sourceGuildId !== this.context.sourceGuildId ||
			proof.issuedAt > Date.now() ||
			proof.expiresAt <= Date.now() ||
			proof.expiresAt - proof.issuedAt > 900_000 ||
			!(await this.tickets.isCurrentGeneration(createUserID(BigInt(proof.userId)), proof.ticketHash))
		)
			throw new InvalidTokenError();
		this.ttl(proof.expiresAt);
	}

	private async loadProof(token: string) {
		const hash = hashMigrationClaimToken(token, 'mp1');
		const parsed = ProofSchema.safeParse(await this.api.services.cache.get<unknown>(this.proofKey(hash)));
		if (!parsed.success) throw new InvalidTokenError();
		const proof = parsed.data;
		await this.assertLive(proof);
		const user = await this.api.services.users.findUnique(createUserID(BigInt(proof.userId)));
		assertMigrationClaimEligible(user, proof.userId, proof.discordUserId);
		await this.assertLive(proof);
		return {proof, hash, user};
	}

	private async readChallenge(hash: string, proof: Proof, proofHash: string, code: string) {
		const parsed = ChallengeSchema.safeParse(await this.api.services.cache.get<unknown>(this.challengeKey(hash)));
		if (!parsed.success) throw new InvalidTokenError();
		const challenge = parsed.data;
		if (
			challenge.proofHash !== proofHash ||
			challenge.userId !== proof.userId ||
			challenge.expiresAt > proof.expiresAt ||
			challenge.expiresAt <= Date.now() ||
			(await this.api.services.cache.get(this.emailPointer(proofHash))) !== hash
		)
			throw new InvalidTokenError();
		if (!timingSafeEqual(Buffer.from(challenge.codeHash, 'hex'), Buffer.from(codeHash(hash, code), 'hex')))
			throw InputValidationError.fromCode('code', ValidationErrorCodes.INVALID_VERIFICATION_CODE);
		this.ttl(challenge.expiresAt);
		return challenge;
	}

	private async limit(userId: string, operation: string, maxAttempts: number, windowMs: number) {
		await checkChangeRateLimit(this.api.services.rateLimit, {
			identifier: `${this.prefix}:rate:${operation}:${userId}`,
			maxAttempts,
			windowMs,
		});
	}
}
