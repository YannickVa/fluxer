// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditService} from '../../admin/services/AdminAuditService';
import type {UserID} from '../../BrandedTypes';
import type {MigrationClaimContext, MigrationClaimTicketService} from './MigrationClaimTicketService';

/** Privileged issuance is audited before publication and fails closed on later errors. */
export class MigrationClaimOperatorService {
	constructor(
		private readonly tickets: MigrationClaimTicketService,
		private readonly audit: Pick<AdminAuditService, 'createAuditLog'>,
		private readonly context: MigrationClaimContext,
		private readonly actorId: UserID,
		private readonly authorize: () => Promise<void>,
	) {}

	private event(action: string, userId: UserID, discordUserId?: string): Promise<void> {
		return this.audit.createAuditLog({
			adminUserId: this.actorId,
			targetType: 'user',
			targetId: userId,
			action,
			auditLogReason: null,
			metadata: new Map([
				['migration_run_id', this.context.migrationRunId],
				['source_guild_id', this.context.sourceGuildId],
				...(discordUserId ? [['discord_user_id', discordUserId] as [string, string]] : []),
			]),
		});
	}

	async issue(userId: UserID, discordUserId: string) {
		await this.authorize();
		await this.event('migration_claim_issue_requested', userId, discordUserId);
		await this.authorize();
		const issued = await this.tickets.issue(userId, discordUserId);
		try {
			await this.authorize();
			await this.event('migration_claim_issued', userId, discordUserId);
			await this.authorize();
			return issued;
		} catch (error) {
			// Never disclose an unaudited/unauthorized credential. Invalidate the account
			// generation; this deliberately fails closed if a concurrent reissue occurred.
			await this.tickets.revoke(userId);
			throw error;
		}
	}

	async revoke(userId: UserID): Promise<void> {
		await this.authorize();
		await this.event('migration_claim_revoke_requested', userId);
		await this.authorize();
		await this.tickets.revoke(userId);
		// Requested + success records are intentionally distinct: a provider failure
		// must never be recorded as a successful operation. No credentials are logged.
		await this.event('migration_claim_revoked', userId);
	}
}
