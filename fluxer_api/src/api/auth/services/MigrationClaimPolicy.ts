// SPDX-License-Identifier: AGPL-3.0-or-later

import {migrationTargetFingerprint} from '@fluxer/config/src/MigrationTargetFingerprint';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import type {APIConfig} from '../../config/APIConfig';
import {fetchOne} from '../../database/CassandraQueryExecution';
import {MigrationClaimReadiness} from '../../database/MigrationClaimReadiness';
import {type MigrationClaimContext, MigrationClaimContextSchema} from './MigrationClaimTicketService';

export {MigrationClaimReadiness, type MigrationClaimReadinessRow} from '../../database/MigrationClaimReadiness';

/** Revocation remains available after readiness/deactivation stops new claims. */
export function requireMigrationClaimRevocationContext(config: APIConfig): MigrationClaimContext {
	const setting = config.auth.migrationClaim;
	if (!config.instance.selfHosted || config.database.backend !== 'postgres') throw new ServiceUnavailableError();
	const parsed = MigrationClaimContextSchema.safeParse({
		instanceFingerprint: setting?.instanceFingerprint,
		migrationRunId: setting?.migrationRunId,
		sourceGuildId: setting?.sourceGuildId,
	});
	if (!parsed.success) throw new ServiceUnavailableError();
	let fingerprint: string;
	try {
		fingerprint = migrationTargetFingerprint(config);
	} catch {
		throw new ServiceUnavailableError();
	}
	if (fingerprint !== parsed.data.instanceFingerprint) throw new ServiceUnavailableError();
	return parsed.data;
}

export async function requireMigrationClaimContext(config: APIConfig): Promise<MigrationClaimContext> {
	if (config.auth.migrationClaim?.enabled !== true) throw new ServiceUnavailableError();
	const context = requireMigrationClaimRevocationContext(config);
	const readiness = await fetchOne(
		MigrationClaimReadiness.select({where: MigrationClaimReadiness.where.eq('scope')}).bind({scope: 'active'}),
	);
	if (
		!readiness ||
		readiness.state !== 'ready' ||
		readiness.instance_fingerprint !== context.instanceFingerprint ||
		readiness.migration_run_id !== context.migrationRunId ||
		readiness.source_guild_id !== context.sourceGuildId ||
		!(readiness.verified_at instanceof Date) ||
		!Number.isFinite(readiness.verified_at.getTime()) ||
		readiness.verified_at.getTime() > Date.now()
	)
		throw new ServiceUnavailableError();
	return context;
}
