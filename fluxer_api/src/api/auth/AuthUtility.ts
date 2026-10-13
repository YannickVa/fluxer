// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import {promisify} from 'node:util';
import type {ApiContext} from '@app/api/ApiContext';
import type {UserID} from '@app/api/BrandedTypes';
import type {KVAccountDeletionQueueService} from '@app/api/infrastructure/KVAccountDeletionQueueService';
import {Logger} from '@app/api/Logger';
import type {User} from '@app/api/models/User';
import {isAccountClosed, isTemporarilyBanned} from '@app/api/user/UserHelpers';
import * as AgeUtils from '@app/api/utils/AgeUtils';
import * as RandomUtils from '@app/api/utils/RandomUtils';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {BotUserAuthEndpointAccessDeniedError} from '@fluxer/errors/src/domains/auth/BotUserAuthEndpointAccessDeniedError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {AccountPermanentlySuspendedError} from '@fluxer/errors/src/domains/user/AccountPermanentlySuspendedError';
import {AccountTemporarilySuspendedError} from '@fluxer/errors/src/domains/user/AccountTemporarilySuspendedError';
import {types} from 'cassandra-driver';

const randomBytesAsync = promisify(crypto.randomBytes);
const ALPHANUMERIC_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

interface ValidateAgeParams {
	dateOfBirth: string;
	minAge: number;
}

interface AccountBanStatus {
	isTempBanned: boolean;
	tempBanExpired: boolean;
}

function base62Encode(buffer: Uint8Array): string {
	let num = BigInt(`0x${Buffer.from(buffer).toString('hex')}`);
	const base = BigInt(ALPHANUMERIC_CHARS.length);
	let encoded = '';
	while (num > 0) {
		const remainder = num % base;
		encoded = ALPHANUMERIC_CHARS[Number(remainder)] + encoded;
		num = num / base;
	}
	return encoded;
}

export async function generateSecureToken(_ctx: ApiContext, length = 64): Promise<string> {
	return RandomUtils.randomString(length);
}

export async function generateAuthToken(_ctx: ApiContext): Promise<string> {
	const bytes = await randomBytesAsync(27);
	let token = base62Encode(new Uint8Array(bytes));
	if (token.length < 36) {
		token += RandomUtils.randomString(36 - token.length);
	}
	if (token.length > 36) {
		token = token.slice(0, 36);
	}
	return `flx_${token}`;
}

export function generateBackupCodes(_ctx: ApiContext): Array<string> {
	return Array.from({length: 10}, () => {
		return `${RandomUtils.randomString(4).toLowerCase()}-${RandomUtils.randomString(4).toLowerCase()}`;
	});
}

export function getTokenIdHash(_ctx: ApiContext, token: string): Uint8Array {
	return new Uint8Array(crypto.createHash('sha256').update(token).digest());
}

export function validateAge(_ctx: ApiContext, {dateOfBirth, minAge}: ValidateAgeParams): boolean {
	return Number.isInteger(minAge) && minAge > 0 && AgeUtils.calculateAge(dateOfBirth) >= minAge;
}

/** Shared registration/claim validation; the caller supplies the trusted instance age policy. */
export function validateDateOfBirth(ctx: ApiContext, {dateOfBirth, minAge}: ValidateAgeParams): types.LocalDate {
	if (!AgeUtils.parseDateOfBirth(dateOfBirth)) {
		throw InputValidationError.fromCode('date_of_birth', ValidationErrorCodes.INVALID_DATE_OF_BIRTH_FORMAT);
	}
	if (!validateAge(ctx, {dateOfBirth, minAge})) {
		throw InputValidationError.fromCode('date_of_birth', ValidationErrorCodes.MUST_BE_MINIMUM_AGE, {minAge});
	}
	return types.LocalDate.fromString(dateOfBirth);
}

export function assertNonBotUser(_ctx: ApiContext, user: User): void {
	if (user.isBot) {
		throw new BotUserAuthEndpointAccessDeniedError();
	}
}

export async function authorizeIpByToken(
	ctx: ApiContext,
	token: string,
): Promise<{
	userId: UserID;
	email: string;
} | null> {
	const {users} = ctx.services;
	return users.authorizeIpByToken(token);
}

function checkAccountBanStatus(_ctx: ApiContext, user: User): AccountBanStatus {
	const hasTempBan = !!(user.flags & UserFlags.DISABLED && user.tempBannedUntil);
	const isTempBanned = isTemporarilyBanned(user);
	return {
		isTempBanned,
		tempBanExpired: hasTempBan && !isTempBanned,
	};
}

export async function handleBanStatus(ctx: ApiContext, user: User): Promise<User> {
	const {users} = ctx.services;
	if (isAccountClosed(user)) throw new AccountPermanentlySuspendedError();
	const banStatus = checkAccountBanStatus(ctx, user);
	if (banStatus.isTempBanned) {
		throw new AccountTemporarilySuspendedError();
	}
	if (banStatus.tempBanExpired) {
		const patched = await users.patchUpsert(user.id, {temp_banned_until: null}, user.toRow());
		return (await users.updateFlags(user.id, (flags) => flags & ~UserFlags.DISABLED)) ?? patched;
	}
	return user;
}

export async function reactivateOnSignIn(
	ctx: ApiContext,
	user: User,
	deletionQueue: Pick<KVAccountDeletionQueueService, 'removeFromQueue'>,
): Promise<User> {
	const {users} = ctx.services;
	let currentUser = user;
	if ((currentUser.flags & UserFlags.DISABLED) !== 0n && !currentUser.tempBannedUntil) {
		currentUser = (await users.updateFlags(currentUser.id, (flags) => flags & ~UserFlags.DISABLED)) ?? currentUser;
		Logger.info({userId: currentUser.id}, 'Auto-undisabled user on sign-in');
	}
	if ((currentUser.flags & UserFlags.SELF_DELETED) !== 0n) {
		const pendingDeletionAt = currentUser.pendingDeletionAt;
		currentUser = await users.updateDeletionSchedule(currentUser, {
			flags: currentUser.flags & ~UserFlags.SELF_DELETED,
			pending_deletion_at: null,
			deletion_reason_code: null,
			deletion_public_reason: null,
			deletion_audit_log_reason: null,
		});
		if (pendingDeletionAt) {
			await users.removePendingDeletion(currentUser.id, pendingDeletionAt);
		}
		await deletionQueue.removeFromQueue(currentUser.id);
		Logger.info({userId: currentUser.id}, 'Auto-cancelled deletion on sign-in');
	}
	return currentUser;
}
