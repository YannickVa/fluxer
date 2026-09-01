// SPDX-License-Identifier: AGPL-3.0-or-later

import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import type {GuildID, RoleID, UserID} from '../../../BrandedTypes';
import type {IGatewayService} from '../../../infrastructure/IGatewayService';
import type {IUserRepository} from '../../../user/IUserRepository';
import {enforceGuildMfa, getGuildMfaFilteredPermissions, hasRequiredGuildMfa} from '../GuildMfaGuard';

interface GuildAuth {
	guildData: GuildResponse;
	checkPermission: (permission: bigint) => Promise<void>;
	checkTargetMember: (targetUserId: UserID) => Promise<void>;
	getMyPermissions: () => Promise<bigint>;
	hasPermission: (permission: bigint) => Promise<boolean>;
	canManageRoles: (targetUserId: UserID, targetRoleId: RoleID) => Promise<boolean>;
}

export class GuildMemberAuthService {
	constructor(
		private readonly gatewayService: IGatewayService,
		private readonly userRepository: IUserRepository,
	) {}

	async getGuildAuthenticated({userId, guildId}: {userId: UserID; guildId: GuildID}): Promise<GuildAuth> {
		const guildData = await this.gatewayService.getGuildData({guildId, userId});
		if (!guildData) throw new MissingAccessError();
		const checkPermission = async (permission: bigint) => {
			const hasPermission = await this.gatewayService.checkPermission({guildId, userId, permission});
			if (!hasPermission) throw new MissingPermissionsError();
			await enforceGuildMfa({guildData, userId, permission, userRepository: this.userRepository});
		};
		const checkTargetMember = async (targetUserId: UserID) => {
			const canManage = await this.gatewayService.checkTargetMember({guildId, userId, targetUserId});
			if (!canManage) throw new MissingPermissionsError();
			await enforceGuildMfa({
				guildData,
				userId,
				permission: Permissions.MODERATE_MEMBERS,
				userRepository: this.userRepository,
			});
		};
		const getMyPermissions = async () =>
			getGuildMfaFilteredPermissions({
				guildData,
				userId,
				permissions: await this.gatewayService.getUserPermissions({guildId, userId}),
				userRepository: this.userRepository,
			});
		const hasPermission = async (permission: bigint) =>
			(await this.gatewayService.checkPermission({guildId, userId, permission})) &&
			(await hasRequiredGuildMfa({guildData, userId, permission, userRepository: this.userRepository}));
		const canManageRoles = async (targetUserId: UserID, targetRoleId: RoleID) =>
			(await this.gatewayService.canManageRoles({guildId, userId, targetUserId, roleId: targetRoleId})) &&
			(await hasRequiredGuildMfa({
				guildData,
				userId,
				permission: Permissions.MANAGE_ROLES,
				userRepository: this.userRepository,
			}));
		return {
			guildData,
			checkPermission,
			checkTargetMember,
			getMyPermissions,
			hasPermission,
			canManageRoles,
		};
	}
}
