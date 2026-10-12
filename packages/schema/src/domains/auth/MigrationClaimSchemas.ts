// SPDX-License-Identifier: AGPL-3.0-or-later

import {createStringType, SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {EmailType, PasswordType} from '@fluxer/schema/src/primitives/UserValidators';
import {z} from 'zod';
import {SudoVerificationSchema} from './AuthSchemas';

const ownershipToken = z
	.string()
	.length(47)
	.regex(/^mc1\.[A-Za-z0-9_-]{43}$/);
const proofToken = z
	.string()
	.length(47)
	.regex(/^mp1\.[A-Za-z0-9_-]{43}$/);
const emailChallengeToken = z
	.string()
	.length(47)
	.regex(/^me1\.[A-Za-z0-9_-]{43}$/);

export const MigrationClaimRedeemRequest = z
	.object({
		token: ownershipToken.describe('One-time privately delivered ownership credential'),
		confirm: z.literal(true).describe('Explicit user confirmation; a link preview must never redeem a credential'),
	})
	.strict();
export type MigrationClaimRedeemRequest = z.infer<typeof MigrationClaimRedeemRequest>;

export const MigrationClaimRedeemResponse = z
	.object({
		proof: proofToken.describe('Restricted claim credential, never a normal login token'),
		expires_at: z.iso.datetime().describe('Original ownership expiry; later steps cannot extend it'),
		username: z.string().describe('Username of the bound migrated account'),
		date_of_birth_required: z.boolean().describe('Whether the account has no previously recorded birth date'),
	})
	.strict();
export type MigrationClaimRedeemResponse = z.infer<typeof MigrationClaimRedeemResponse>;

export const MigrationClaimEmailRequest = z
	.object({
		proof: proofToken,
		email: EmailType.describe('Address the user wants to verify for their migrated account'),
	})
	.strict();
export type MigrationClaimEmailRequest = z.infer<typeof MigrationClaimEmailRequest>;

export const MigrationClaimEmailResponse = z
	.object({
		challenge: emailChallengeToken.describe('Email challenge bound to this restricted proof'),
		expires_at: z.iso.datetime().describe('Code expiry, bounded by the original ownership expiry'),
		resend_available_at: z.iso.datetime(),
	})
	.strict();
export type MigrationClaimEmailResponse = z.infer<typeof MigrationClaimEmailResponse>;

export const MigrationClaimCompleteRequest = z
	.object({
		proof: proofToken,
		challenge: emailChallengeToken,
		code: createStringType(1, 32).describe('Code sent to the requested email address'),
		password: PasswordType,
		date_of_birth: createStringType(10, 10)
			.refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
			.optional(),
		consent: z.boolean().default(false).describe('Agreement to the instance terms and privacy policy when required'),
	})
	.strict();
export type MigrationClaimCompleteRequest = z.infer<typeof MigrationClaimCompleteRequest>;

export const MigrationClaimCompleteResponse = z
	.object({
		user_id: SnowflakeStringType,
		login_required: z.literal(true).describe('Sign in through the normal login flow; claiming does not mint a session'),
	})
	.strict();
export type MigrationClaimCompleteResponse = z.infer<typeof MigrationClaimCompleteResponse>;

const operatorConfirmation = {
	...SudoVerificationSchema.omit({password: true}).shape,
	user_id: SnowflakeStringType,
	confirm: z.literal(true),
};
export const MigrationClaimIssueRequest = z
	.object({
		...operatorConfirmation,
		discord_user_id: SnowflakeStringType.describe('Exact privately verified Discord recipient, never a display name'),
	})
	.strict();
export type MigrationClaimIssueRequest = z.infer<typeof MigrationClaimIssueRequest>;
export const MigrationClaimIssueResponse = z
	.object({
		token: ownershipToken.describe('One-time ownership credential; deliver privately to the exact Discord recipient'),
		expires_at: z.iso.datetime(),
		discord_user_id: SnowflakeStringType,
	})
	.strict();
export type MigrationClaimIssueResponse = z.infer<typeof MigrationClaimIssueResponse>;
export const MigrationClaimRevokeRequest = z.object(operatorConfirmation).strict();
export type MigrationClaimRevokeRequest = z.infer<typeof MigrationClaimRevokeRequest>;
export const MigrationClaimRevokeResponse = z.object({revoked: z.literal(true)}).strict();
