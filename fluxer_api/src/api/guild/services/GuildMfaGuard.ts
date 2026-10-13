// SPDX-License-Identifier: AGPL-3.0-or-later

import {ELEVATED_MFA_PERMISSIONS} from '@app/api/guild/services/GuildMfaEnforcement';
import {GuildMFALevel} from '@fluxer/constants/src/GuildConstants';
import {MfaNotEnabledError} from '@fluxer/errors/src/domains/auth/MfaNotEnabledError';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import type {UserID} from '@app/api/BrandedTypes';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';

export async function hasRequiredGuildMfa(params: {
	guildData: GuildResponse;
	userId: UserID;
	permission: bigint;
	userRepository: UserRepository;
}): Promise<boolean> {
	const {guildData, userId, permission, userRepository} = params;
	if (guildData.mfa_level !== GuildMFALevel.ELEVATED || (permission & ELEVATED_MFA_PERMISSIONS) === 0n) {
		return true;
	}
	const actor = await userRepository.findUnique(userId);
	return actor !== null && actor.authenticatorTypes.size > 0;
}

export async function enforceGuildMfa(params: {
	guildData: GuildResponse;
	userId: UserID;
	permission: bigint;
	userRepository: UserRepository;
}): Promise<void> {
	if (!(await hasRequiredGuildMfa(params))) {
		throw new MfaNotEnabledError();
	}
}

export async function getGuildMfaFilteredPermissions(params: {
	guildData: GuildResponse;
	userId: UserID;
	permissions: bigint;
	userRepository: UserRepository;
}): Promise<bigint> {
	const {permissions, ...guardParams} = params;
	return (await hasRequiredGuildMfa({...guardParams, permission: permissions}))
		? permissions
		: permissions & ~ELEVATED_MFA_PERMISSIONS;
}
