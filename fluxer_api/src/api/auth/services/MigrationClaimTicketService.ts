// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, randomBytes} from 'node:crypto';
import {InvalidTokenError} from '@fluxer/errors/src/domains/core/InvalidTokenError';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';
import {z} from 'zod';
import {createUserID, type UserID} from '../../BrandedTypes';
import type {User} from '../../models/User';
import type {IUserRepository} from '../../user/IUserRepository';
import {assertMigrationClaimEligible} from '../../user/MigrationAccountEligibility';

const LIFETIME_SECONDS = 15 * 60;
export const MigrationClaimIdSchema = z
	.string()
	.refine((value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn);
export const MigrationClaimContextSchema = z
	.object({
		instanceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
		migrationRunId: z.string().uuid(),
		sourceGuildId: MigrationClaimIdSchema,
	})
	.strict();
const TicketSchema = z
	.object({
		version: z.literal(1),
		context: MigrationClaimContextSchema,
		userId: MigrationClaimIdSchema,
		discordUserId: MigrationClaimIdSchema,
		issuedAt: z.number().int().nonnegative(),
		expiresAt: z.number().int().positive(),
	})
	.strict()
	.refine((value) => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= LIFETIME_SECONDS * 1000);

export type MigrationClaimContext = z.infer<typeof MigrationClaimContextSchema>;
type ClaimCache = Pick<ICacheService, 'get' | 'set' | 'getAndDelete' | 'delete'>;

export function hashMigrationClaimToken(token: string, kind: 'mc1' | 'mp1' | 'me1' = 'mc1'): string {
	if (
		!new RegExp(`^${kind}\\.[A-Za-z0-9_-]{43}$`).test(token) ||
		Buffer.from(token.slice(4), 'base64url').toString('base64url') !== token.slice(4)
	)
		throw new InvalidTokenError();
	return createHash('sha256').update(token).digest('hex');
}

/**
 * One-time ownership proof, not a session token or a completed claim. The trusted
 * operator/server policy supplies the context; never accept it from the claim client.
 * HTTP authorization, explicit confirmation, email/DOB/password completion and private
 * Discord delivery are separate gates and must be wired before enabling this service.
 */
export class MigrationClaimTicketService {
	private readonly context: MigrationClaimContext;
	private readonly prefix: string;

	constructor(
		private readonly cache: ClaimCache,
		private readonly users: Pick<IUserRepository, 'findUnique'>,
		context: MigrationClaimContext,
	) {
		const parsed = MigrationClaimContextSchema.safeParse(context);
		if (!parsed.success) throw new Error('Invalid migration claim context; values omitted.');
		this.context = parsed.data;
		this.prefix = `migration-claim:${this.context.instanceFingerprint}:${this.context.migrationRunId}:${this.context.sourceGuildId}`;
	}

	async issue(userId: UserID, discordUserId: string): Promise<{token: string; expiresAt: Date; discordUserId: string}> {
		if (
			!MigrationClaimIdSchema.safeParse(userId.toString()).success ||
			!MigrationClaimIdSchema.safeParse(discordUserId).success
		)
			throw new InvalidTokenError();
		assertMigrationClaimEligible(await this.users.findUnique(userId), userId.toString(), discordUserId);
		const token = `mc1.${randomBytes(32).toString('base64url')}`;
		const hash = hashMigrationClaimToken(token);
		const now = Date.now();
		const ticket: z.infer<typeof TicketSchema> = {
			version: 1,
			context: {...this.context},
			userId: userId.toString(),
			discordUserId,
			issuedAt: now,
			expiresAt: now + LIFETIME_SECONDS * 1000,
		};
		// Publish the active pointer last. A failure returns no credential; an orphaned
		// hash-only record expires. Last publication wins across concurrent reissues.
		await this.cache.set(`${this.prefix}:token:${hash}`, ticket, LIFETIME_SECONDS);
		await this.cache.set(`${this.prefix}:account:${userId}`, hash, LIFETIME_SECONDS);
		return {token, expiresAt: new Date(ticket.expiresAt), discordUserId};
	}

	async consume(
		token: string,
	): Promise<{user: User; discordUserId: string; context: MigrationClaimContext; expiresAt: Date}> {
		const hash = hashMigrationClaimToken(token);
		// GETDEL is the single-use boundary. Never restore a consumed record on any
		// later failure: the operator must reissue rather than risk credential replay.
		const raw = await this.cache.getAndDelete<unknown>(`${this.prefix}:token:${hash}`);
		const parsed = TicketSchema.safeParse(raw);
		if (!parsed.success) throw new InvalidTokenError();
		const ticket = parsed.data;
		if (
			ticket.context.instanceFingerprint !== this.context.instanceFingerprint ||
			ticket.context.migrationRunId !== this.context.migrationRunId ||
			ticket.context.sourceGuildId !== this.context.sourceGuildId ||
			ticket.issuedAt > Date.now() ||
			ticket.expiresAt <= Date.now() ||
			(await this.cache.get<unknown>(`${this.prefix}:account:${ticket.userId}`)) !== hash
		)
			throw new InvalidTokenError();
		const user = await this.users.findUnique(createUserID(BigInt(ticket.userId)));
		assertMigrationClaimEligible(user, ticket.userId, ticket.discordUserId);
		// Revocation/reissue may occur while the account read is in flight. Check the
		// active generation again at the acceptance boundary, and re-check expiry.
		if (
			(await this.cache.get<unknown>(`${this.prefix}:account:${ticket.userId}`)) !== hash ||
			ticket.expiresAt <= Date.now()
		)
			throw new InvalidTokenError();
		return {
			user,
			discordUserId: ticket.discordUserId,
			context: {...this.context},
			expiresAt: new Date(ticket.expiresAt),
		};
	}

	async revoke(userId: UserID): Promise<void> {
		if (!MigrationClaimIdSchema.safeParse(userId.toString()).success) throw new InvalidTokenError();
		// Invalidate every ticket and restricted completion proof in this approved run.
		// Hash-only records expire naturally. A committed claim or normal login session
		// cannot be undone here; those need the existing account/session controls.
		await this.cache.delete(`${this.prefix}:account:${userId}`);
	}

	/** Restricted completion must keep checking the original ownership generation. */
	async isCurrentGeneration(userId: UserID, ticketHash: string): Promise<boolean> {
		if (!MigrationClaimIdSchema.safeParse(userId.toString()).success || !/^[0-9a-f]{64}$/.test(ticketHash))
			return false;
		return (await this.cache.get<unknown>(`${this.prefix}:account:${userId}`)) === ticketHash;
	}
}
