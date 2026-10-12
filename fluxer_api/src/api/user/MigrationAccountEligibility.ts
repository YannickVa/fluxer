// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {InvalidTokenError} from '@fluxer/errors/src/domains/core/InvalidTokenError';
import type {User} from '../models/User';

const FORBIDDEN_FLAGS =
	UserFlags.STAFF |
	UserFlags.STAFF_HIDDEN |
	UserFlags.RATE_LIMIT_BYPASS |
	UserFlags.APP_STORE_REVIEWER |
	UserFlags.NOT_SUSPICIOUS |
	UserFlags.DELETED |
	UserFlags.SELF_DELETED |
	UserFlags.DISABLED |
	UserFlags.DISABLED_SUSPICIOUS_ACTIVITY;

/** Keep ticket issuance/redemption and the final database claim on the same policy. */
export function assertMigrationClaimEligible(
	user: User | null,
	userId: string,
	discordUserId: string,
): asserts user is User {
	if (
		!user ||
		!/^[1-9][0-9]{0,19}$/.test(discordUserId) ||
		BigInt(discordUserId) > 0xffffffffffffffffn ||
		user.id.toString() !== userId ||
		userId !== discordUserId ||
		!user.traits.has('discord_seed') ||
		user.traits.has('sso') ||
		user.traits.has('webhook_ghost') ||
		!user.traits.has(`discord_id:${discordUserId}`) ||
		[...user.traits].filter((trait) => trait.startsWith('discord_id:')).length !== 1 ||
		user.isBot ||
		user.isSystem ||
		user.email !== null ||
		user.passwordHash !== null ||
		user.acls.size > 0 ||
		(user.flags & FORBIDDEN_FLAGS) !== 0n ||
		user.authenticatorTypes.size > 0 ||
		user.totpSecret !== null ||
		user.hasVerifiedPhone ||
		user.pendingDeletionAt !== null ||
		(user.tempBannedUntil !== null && user.tempBannedUntil.getTime() > Date.now())
	)
		throw new InvalidTokenError();
}
