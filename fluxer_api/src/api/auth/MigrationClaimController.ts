// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {getRegionalMinimumAge} from '@fluxer/constants/src/RegionalMinimumAge';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {MfaNotEnabledError} from '@fluxer/errors/src/domains/auth/MfaNotEnabledError';
import {AccessDeniedError} from '@fluxer/errors/src/domains/core/AccessDeniedError';
import {AppErrorHandler} from '@fluxer/errors/src/domains/core/ErrorHandlers';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import {createLogger} from '@fluxer/logger/src/Logger';
import {
	MigrationClaimCompleteRequest,
	MigrationClaimCompleteResponse,
	MigrationClaimEmailRequest,
	MigrationClaimEmailResponse,
	MigrationClaimIssueRequest,
	MigrationClaimIssueResponse,
	MigrationClaimRedeemRequest,
	MigrationClaimRedeemResponse,
	MigrationClaimRevokeRequest,
	MigrationClaimRevokeResponse,
} from '@fluxer/schema/src/domains/auth/MigrationClaimSchemas';
import type {Context} from 'hono';
import {createMiddleware} from 'hono/factory';
import {createUserID} from '../BrandedTypes';
import {requireAdminACL} from '../middleware/AdminMiddleware';
import {LocalAuthMiddleware} from '../middleware/LocalAuthMiddleware';
import {RateLimitMiddleware} from '../middleware/RateLimitMiddleware';
import {OpenAPI} from '../middleware/ResponseTypeMiddleware';
import {getInstanceConfigRepository} from '../middleware/ServiceSingletons';
import {SudoModeMiddleware} from '../middleware/SudoModeMiddleware';
import type {User} from '../models/User';
import {RateLimitConfigs} from '../RateLimitConfig';
import type {HonoApp, HonoEnv} from '../types/HonoEnv';
import {LEGACY_SUSPICIOUS_DISABLED_FLAG} from '../user/MigrationAccountEligibility';
import {Validator} from '../Validator';
import {MigrationClaimCompletionService} from './services/MigrationClaimCompletionService';
import {MigrationClaimOperatorService} from './services/MigrationClaimOperatorService';
import {requireMigrationClaimContext, requireMigrationClaimRevocationContext} from './services/MigrationClaimPolicy';
import {MigrationClaimTicketService} from './services/MigrationClaimTicketService';
import {userHasMfa} from './services/SudoMethods';
import {requireSudoMode} from './services/SudoVerificationService';

const claimLogger = createLogger('migration_claim');

const privateResponse = createMiddleware<HonoEnv>(async (ctx, next) => {
	const headers = () => {
		ctx.header('Cache-Control', 'no-store');
		ctx.header('Pragma', 'no-cache');
		ctx.header('Referrer-Policy', 'no-referrer');
	};
	headers();
	// No credentials in query strings; only explicit JSON POST requests are accepted.
	if (
		new URL(ctx.req.url).search ||
		ctx.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
	) {
		ctx.res = await AppErrorHandler(InputValidationError.fromCode('request', ValidationErrorCodes.INVALID_FORMAT), ctx);
		headers();
		return ctx.res;
	}
	await next();
	// Hono handles downstream errors inside next(). Reapply after that handler has
	// constructed its response, which otherwise replaces no-store with no-cache.
	headers();
	return undefined;
});

async function privateOperation<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof FluxerError) throw error;
		// Provider errors can contain email content, parser excerpts or credentials.
		claimLogger.error({operation: 'migration_claim'}, 'Migration claim failed; private details omitted.');
		throw new ServiceUnavailableError();
	}
}

const approvedRun = createMiddleware<HonoEnv>(async (ctx, next) => {
	const api = ctx.get('apiContext');
	const context = await privateOperation(() => requireMigrationClaimContext(api.services.config));
	const authorize = async () => {
		const current = await requireMigrationClaimContext(api.services.config);
		if (
			current.instanceFingerprint !== context.instanceFingerprint ||
			current.migrationRunId !== context.migrationRunId ||
			current.sourceGuildId !== context.sourceGuildId
		)
			throw new ServiceUnavailableError();
	};
	ctx.set(
		'migrationClaimCompletionService',
		new MigrationClaimCompletionService(
			api,
			{
				instance: getInstanceConfigRepository(),
				accountPolicy: {getMinimumAgeForRegion: (countryCode) => getRegionalMinimumAge(countryCode)},
				authorize,
			},
			context,
		),
	);
	await next();
});

async function operatorService(
	ctx: Context<HonoEnv>,
	body: MigrationClaimIssueRequest | MigrationClaimRevokeRequest,
	revoke: boolean,
): Promise<MigrationClaimOperatorService> {
	// Service/API keys and bots cannot substitute for a human MFA confirmation.
	if (!['session', 'bearer'].includes(ctx.get('authTokenType') ?? '')) throw new AccessDeniedError();
	const api = ctx.get('apiContext');
	const actorId = ctx.get('adminUserId');
	const actor = await api.services.users.findUnique(actorId);
	function checkActor(user: User | null): asserts user is User {
		if (
			!user ||
			user.id !== actorId ||
			user.isBot ||
			user.isSystem ||
			(user.flags &
				(UserFlags.DELETED |
					UserFlags.SELF_DELETED |
					UserFlags.DISABLED |
					LEGACY_SUSPICIOUS_DISABLED_FLAG |
					UserFlags.SPAMMER |
					UserFlags.ACCOUNT_LIMITED)) !==
				0n ||
			user.pendingDeletionAt !== null ||
			(user.tempBannedUntil !== null && user.tempBannedUntil.getTime() > Date.now()) ||
			user.migrationLegacySecurity.suspiciousActivityFlags !== 0 ||
			(!user.acls.has(AdminACLs.WILDCARD) &&
				(!user.acls.has(AdminACLs.AUTHENTICATE) || !user.acls.has(AdminACLs.MIGRATION_CLAIM_MANAGE)))
		)
			throw new AccessDeniedError();
		if (!userHasMfa(user)) throw new MfaNotEnabledError();
	}
	checkActor(actor);
	await requireSudoMode(ctx, actor, body);
	const readContext = () =>
		revoke
			? Promise.resolve(requireMigrationClaimRevocationContext(api.services.config))
			: requireMigrationClaimContext(api.services.config);
	const context = await readContext();
	const authorize = async () => {
		checkActor(await api.services.users.findUnique(actorId));
		const current = await readContext();
		if (
			current.instanceFingerprint !== context.instanceFingerprint ||
			current.migrationRunId !== context.migrationRunId ||
			current.sourceGuildId !== context.sourceGuildId
		)
			throw new ServiceUnavailableError();
	};
	return new MigrationClaimOperatorService(
		new MigrationClaimTicketService(api.services.cache, api.services.users, context),
		ctx.get('adminService').auditService,
		context,
		actorId,
		authorize,
	);
}

/** POST-only restricted workflow. Issuance and private delivery are separate privileged operations. */
export function MigrationClaimController(app: HonoApp): void {
	app.post(
		'/admin/migration/claims/issue',
		privateResponse,
		RateLimitMiddleware(RateLimitConfigs.ADMIN_MIGRATION_CLAIM_ISSUE),
		requireAdminACL(AdminACLs.MIGRATION_CLAIM_MANAGE),
		LocalAuthMiddleware,
		SudoModeMiddleware,
		Validator('json', MigrationClaimIssueRequest),
		OpenAPI({
			operationId: 'issue_migration_claim',
			summary: 'Issue a private migration ownership credential',
			description:
				'Human administrator MFA confirmation and active verified readiness are required. Deliver only to the exact Discord recipient; issuance is not delivery.',
			responseSchema: MigrationClaimIssueResponse,
			sensitiveResponse: true,
			security: ['sessionToken', 'bearerToken'],
			tags: ['Admin'],
		}),
		async (ctx) =>
			ctx.json(
				await privateOperation(async () => {
					const body = ctx.req.valid('json');
					const operator = await operatorService(ctx, body, false);
					const issued = await operator.issue(createUserID(BigInt(body.user_id)), body.discord_user_id);
					return {
						token: issued.token,
						expires_at: issued.expiresAt.toISOString(),
						discord_user_id: issued.discordUserId,
					};
				}),
			),
	);
	app.post(
		'/admin/migration/claims/revoke',
		privateResponse,
		RateLimitMiddleware(RateLimitConfigs.ADMIN_MIGRATION_CLAIM_REVOKE),
		requireAdminACL(AdminACLs.MIGRATION_CLAIM_MANAGE),
		LocalAuthMiddleware,
		SudoModeMiddleware,
		Validator('json', MigrationClaimRevokeRequest),
		OpenAPI({
			operationId: 'revoke_migration_claim',
			summary: 'Revoke outstanding migration ownership credentials',
			description:
				'Invalidate tickets and restricted proofs for the configured migration, even while claims are stopped. Does not undo completed accounts or normal sessions.',
			responseSchema: MigrationClaimRevokeResponse,
			sensitiveResponse: true,
			security: ['sessionToken', 'bearerToken'],
			tags: ['Admin'],
		}),
		async (ctx) =>
			ctx.json(
				await privateOperation(async () => {
					const body = ctx.req.valid('json');
					const operator = await operatorService(ctx, body, true);
					await operator.revoke(createUserID(BigInt(body.user_id)));
					return {revoked: true as const};
				}),
			),
	);
	app.post(
		'/auth/migration/redeem',
		privateResponse,
		RateLimitMiddleware(RateLimitConfigs.AUTH_MIGRATION_REDEEM),
		LocalAuthMiddleware,
		approvedRun,
		Validator('json', MigrationClaimRedeemRequest),
		OpenAPI({
			operationId: 'redeem_migration_claim',
			summary: 'Confirm a migration ownership link',
			description:
				'Explicitly redeem a one-time ownership link for a restricted proof. Does not create a login session.',
			responseSchema: MigrationClaimRedeemResponse,
			sensitiveResponse: true,
			security: [],
			tags: ['Auth'],
		}),
		async (ctx) =>
			ctx.json(await privateOperation(() => ctx.get('migrationClaimCompletionService').redeem(ctx.req.valid('json')))),
	);
	app.post(
		'/auth/migration/email',
		privateResponse,
		RateLimitMiddleware(RateLimitConfigs.AUTH_MIGRATION_EMAIL),
		LocalAuthMiddleware,
		approvedRun,
		Validator('json', MigrationClaimEmailRequest),
		OpenAPI({
			operationId: 'verify_migration_claim_email',
			summary: 'Request a migration email verification code',
			description: 'Send an email code bound to the restricted proof and original ownership deadline.',
			responseSchema: MigrationClaimEmailResponse,
			sensitiveResponse: true,
			security: [],
			tags: ['Auth'],
		}),
		async (ctx) =>
			ctx.json(
				await privateOperation(() => ctx.get('migrationClaimCompletionService').requestEmail(ctx.req.valid('json'))),
			),
	);
	app.post(
		'/auth/migration/complete',
		privateResponse,
		RateLimitMiddleware(RateLimitConfigs.AUTH_MIGRATION_COMPLETE),
		LocalAuthMiddleware,
		approvedRun,
		Validator('json', MigrationClaimCompleteRequest),
		OpenAPI({
			operationId: 'complete_migration_claim',
			summary: 'Complete a migrated account claim',
			description:
				'Verify email, password, birth date and consent before an atomic claim. Normal login is required afterwards.',
			responseSchema: MigrationClaimCompleteResponse,
			sensitiveResponse: true,
			security: [],
			tags: ['Auth'],
		}),
		async (ctx) =>
			ctx.json(
				await privateOperation(() =>
					ctx.get('migrationClaimCompletionService').complete(ctx.req.valid('json'), ctx.req.raw),
				),
			),
	);
}
