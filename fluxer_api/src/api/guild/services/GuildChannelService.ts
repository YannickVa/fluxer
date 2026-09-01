// SPDX-License-Identifier: AGPL-3.0-or-later

import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {UnknownGuildError} from '@fluxer/errors/src/domains/guild/UnknownGuildError';
import type {ChannelCreateRequest} from '@fluxer/schema/src/domains/channel/ChannelRequestSchemas';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';
import type {ChannelID, GuildID, UserID} from '../../BrandedTypes';
import {mapChannelToResponse} from '../../channel/ChannelMappers';
import type {IChannelRepository} from '../../channel/IChannelRepository';
import type {IGatewayService} from '../../infrastructure/IGatewayService';
import type {ISnowflakeService} from '../../infrastructure/ISnowflakeService';
import type {UserCacheService} from '../../infrastructure/UserCacheService';
import type {LimitConfigService} from '../../limits/LimitConfigService';
import type {RequestCache} from '../../middleware/RequestCacheMiddleware';
import type {IUserRepository} from '../../user/IUserRepository';
import type {GuildAuditLogService} from '../GuildAuditLogService';
import type {IGuildRepositoryAggregate} from '../repositories/IGuildRepositoryAggregate';
import {ChannelOperationsService} from './channel/ChannelOperationsService';
import {enforceGuildMfa} from './GuildMfaGuard';

export class GuildChannelService {
	private readonly channelOps: ChannelOperationsService;

	constructor(
		private readonly channelRepository: IChannelRepository,
		guildRepository: IGuildRepositoryAggregate,
		private readonly userCacheService: UserCacheService,
		private readonly gatewayService: IGatewayService,
		cacheService: ICacheService,
		snowflakeService: ISnowflakeService,
		guildAuditLogService: GuildAuditLogService,
		limitConfigService: LimitConfigService,
		private readonly userRepository: IUserRepository,
	) {
		this.channelOps = new ChannelOperationsService(
			channelRepository,
			guildRepository,
			userCacheService,
			gatewayService,
			cacheService,
			snowflakeService,
			guildAuditLogService,
			limitConfigService,
		);
	}

	async getChannels(params: {
		userId: UserID;
		guildId: GuildID;
		requestCache: RequestCache;
	}): Promise<Array<ChannelResponse>> {
		try {
			await this.gatewayService.getGuildData({guildId: params.guildId, userId: params.userId});
		} catch (error) {
			if (error instanceof UnknownGuildError) {
				throw error;
			}
			throw error;
		}
		const viewableChannelIds = await this.gatewayService.getViewableChannels({
			guildId: params.guildId,
			userId: params.userId,
		});
		const channels = await this.channelRepository.listGuildChannels(params.guildId);
		const viewableChannels = channels.filter((channel) => viewableChannelIds.includes(channel.id));
		return Promise.all(
			viewableChannels.map((channel) => {
				return mapChannelToResponse({
					channel,
					currentUserId: null,
					userCacheService: this.userCacheService,
					requestCache: params.requestCache,
				});
			}),
		);
	}

	async createChannel(
		params: {
			userId: UserID;
			guildId: GuildID;
			data: ChannelCreateRequest;
			requestCache: RequestCache;
		},
		auditLogReason?: string | null,
	): Promise<ChannelResponse> {
		await this.checkPermission({
			userId: params.userId,
			guildId: params.guildId,
			permission: Permissions.MANAGE_CHANNELS,
		});
		return this.channelOps.createChannel(params, auditLogReason);
	}

	async updateChannelPositions(
		params: {
			userId: UserID;
			guildId: GuildID;
			updates: Array<{
				channelId: ChannelID;
				position?: number;
				parentId: ChannelID | null | undefined;
				precedingSiblingId: ChannelID | null | undefined;
				lockPermissions: boolean;
			}>;
			requestCache: RequestCache;
		},
		auditLogReason?: string | null,
	): Promise<void> {
		await this.checkPermission({
			userId: params.userId,
			guildId: params.guildId,
			permission: Permissions.MANAGE_CHANNELS,
		});
		await this.channelOps.updateChannelPositionsByList({
			userId: params.userId,
			guildId: params.guildId,
			updates: params.updates,
			requestCache: params.requestCache,
			auditLogReason: auditLogReason ?? null,
		});
	}

	async sanitizeTextChannelNames(params: {guildId: GuildID; requestCache: RequestCache}): Promise<void> {
		await this.channelOps.sanitizeTextChannelNames(params);
	}

	private async checkPermission(params: {userId: UserID; guildId: GuildID; permission: bigint}): Promise<void> {
		const {guildId, userId, permission} = params;
		const [hasPermission, guildData] = await Promise.all([
			this.gatewayService.checkPermission({guildId, userId, permission}),
			this.gatewayService.getGuildData({guildId, userId}),
		]);
		if (!hasPermission) throw new MissingPermissionsError();
		if (!guildData) throw new UnknownGuildError();
		await enforceGuildMfa({guildData, userId, permission, userRepository: this.userRepository});
	}
}
