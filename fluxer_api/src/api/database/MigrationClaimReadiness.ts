// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from './CassandraTableDsl';

export interface MigrationClaimReadinessRow {
	scope: string;
	instance_fingerprint: string;
	migration_run_id: string;
	source_guild_id: string;
	state: 'ready' | 'preparing';
	verified_at: Date;
}

/** Database-resident binding: a reset must not inherit claim authority from Redis. */
export const MigrationClaimReadiness = defineTable<MigrationClaimReadinessRow, 'scope'>({
	name: 'migration_claim_readiness',
	columns: ['scope', 'instance_fingerprint', 'migration_run_id', 'source_guild_id', 'state', 'verified_at'],
	primaryKey: ['scope'],
});
