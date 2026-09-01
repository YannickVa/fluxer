// SPDX-License-Identifier: AGPL-3.0-or-later

import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildMFALevel} from '@fluxer/constants/src/GuildConstants';
import {MfaNotEnabledError} from '@fluxer/errors/src/domains/auth/MfaNotEnabledError';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import type {UserID} from '../../BrandedTypes';
import type {IUserRepository} from '../../user/IUserRepository';

const ELEVATED_MFA_PERMISSIONS =
	Permissions.KICK_MEMBERS |
	Permissions.BAN_MEMBERS |
	Permissions.ADMINISTRATOR |
	Permissions.MANAGE_CHANNELS |
	Permissions.MANAGE_GUILD |
	Permissions.MANAGE_MESSAGES |
	Permissions.MANAGE_ROLES |
	Permissions.MANAGE_WEBHOOKS |
	Permissions.MODERATE_MEMBERS;

export async function hasRequiredGuildMfa(params: {
	guildData: GuildResponse;
	userId: UserID;
	permission: bigint;
	userRepository: IUserRepository;
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
	userRepository: IUserRepository;
}): Promise<void> {
	if (!(await hasRequiredGuildMfa(params))) {
		throw new MfaNotEnabledError();
	}
}

export async function getGuildMfaFilteredPermissions(params: {
	guildData: GuildResponse;
	userId: UserID;
	permissions: bigint;
	userRepository: IUserRepository;
}): Promise<bigint> {
	const {permissions, ...guardParams} = params;
	return (await hasRequiredGuildMfa({...guardParams, permission: permissions}))
		? permissions
		: permissions & ~ELEVATED_MFA_PERMISSIONS;
}
