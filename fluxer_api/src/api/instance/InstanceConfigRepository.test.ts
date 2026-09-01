// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, describe, expect, it, vi} from 'vitest';
import {setCassandraQueryExecutorForTesting} from '../database/CassandraQueryExecution';
import type {PreparedQuery} from '../database/CassandraTypes';
import {InMemoryCassandraQueryExecutor} from '../test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '../test/mocks/MockKVProvider';
import {
	INSTANCE_CONFIG_REFRESH_CHANNEL,
	InstanceConfigRepository,
	type InstanceRegistrationConfig,
} from './InstanceConfigRepository';

class CountingInMemoryCassandraQueryExecutor extends InMemoryCassandraQueryExecutor {
	instanceConfigSelects = 0;

	override async executeQuery<T = Record<string, unknown>>(query: PreparedQuery): Promise<Array<T>> {
		if (query.kvMeta?.action === 'select' && query.kvMeta.table.name === 'instance_configuration') {
			this.instanceConfigSelects++;
		}
		return super.executeQuery<T>(query);
	}
}

describe('InstanceConfigRepository', () => {
	const repositories: Array<InstanceConfigRepository> = [];

	afterEach(() => {
		for (const repository of repositories) {
			repository.shutdown();
		}
		repositories.length = 0;
	});

	function createRepository(kvProvider: MockKVProvider): InstanceConfigRepository {
		const repository = new InstanceConfigRepository(kvProvider);
		repositories.push(repository);
		return repository;
	}

	it('serves repeated config reads from the hydrated in-memory cache', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setRegistrationConfig({mode: 'closed'});
		executor.instanceConfigSelects = 0;

		expect(await repository.getRegistrationConfig()).toEqual({
			mode: 'closed',
			admin_registration_urls_enabled: true,
		} satisfies InstanceRegistrationConfig);
		expect(await repository.getRegistrationConfig()).toEqual({
			mode: 'closed',
			admin_registration_urls_enabled: true,
		} satisfies InstanceRegistrationConfig);
		expect(executor.instanceConfigSelects).toBe(0);
		expect(kvProvider.getSubscription().subscribedChannels).toContain(INSTANCE_CONFIG_REFRESH_CHANNEL);
	});

	it('refreshes a hydrated cache after another repository publishes a config update', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const reader = createRepository(kvProvider);
		const writer = createRepository(kvProvider);

		expect(await reader.getRegistrationConfig()).toEqual({
			mode: 'open',
			admin_registration_urls_enabled: true,
		} satisfies InstanceRegistrationConfig);

		await writer.setRegistrationConfig({mode: 'approval'});

		await vi.waitFor(async () => {
			expect(await reader.getRegistrationConfig()).toEqual({
				mode: 'approval',
				admin_registration_urls_enabled: true,
			} satisfies InstanceRegistrationConfig);
		});
	});

	it('provides safe disabled defaults for onboarding and support', async () => {
		setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
		const repository = createRepository(new MockKVProvider());

		const config = await repository.getAppPublicConfig();

		expect(config.onboarding).toEqual({
			enabled: false,
			version: 1,
			enabled_at: null,
			show_for_existing_users: false,
			welcome_message: null,
			operator_name: null,
			availability_message: null,
			primary_guild_id: null,
			rules_channel_id: null,
			introduction_channel_id: null,
			mfa_policy: 'recommended',
			steps: {
				profile: true,
				security: true,
				notifications: true,
				media: true,
				community: true,
			},
		});
		expect(config.support).toEqual({
			status_url: null,
			support_user_id: null,
			service_updates_channel_id: null,
			feedback_channel_id: null,
		});
	});

	it('merges onboarding step updates without resetting sibling settings', async () => {
		setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
		const repository = createRepository(new MockKVProvider());

		await repository.setAppPublicConfig({
			onboarding: {
				welcome_message: 'Welcome to the pilot',
				steps: {media: false},
			},
		});
		const updated = await repository.setAppPublicConfig({
			onboarding: {steps: {notifications: false}},
		});

		expect(updated.onboarding.welcome_message).toBe('Welcome to the pilot');
		expect(updated.onboarding.steps).toEqual({
			profile: true,
			security: true,
			notifications: false,
			media: false,
			community: true,
		});
	});

	it('merges support destination updates without clearing configured siblings', async () => {
		setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
		const repository = createRepository(new MockKVProvider());

		await repository.setAppPublicConfig({
			support: {
				support_user_id: '323456789012345678',
				service_updates_channel_id: '423456789012345678',
			},
		});
		const updated = await repository.setAppPublicConfig({
			support: {feedback_channel_id: '523456789012345678'},
		});

		expect(updated.support).toEqual({
			status_url: null,
			support_user_id: '323456789012345678',
			service_updates_channel_id: '423456789012345678',
			feedback_channel_id: '523456789012345678',
		});
	});

	it('records rollout time only when onboarding transitions from disabled to enabled', async () => {
		setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
		const repository = createRepository(new MockKVProvider());

		const enabled = await repository.setAppPublicConfig({onboarding: {enabled: true}});
		const enabledAt = enabled.onboarding.enabled_at;
		expect(enabledAt).not.toBeNull();

		const edited = await repository.setAppPublicConfig({onboarding: {welcome_message: 'Hello'}});
		expect(edited.onboarding.enabled_at).toBe(enabledAt);

		await repository.setAppPublicConfig({onboarding: {enabled: false}});
		const reenabled = await repository.setAppPublicConfig({onboarding: {enabled: true}});
		expect(reenabled.onboarding.enabled_at).not.toBeNull();
		expect(Date.parse(reenabled.onboarding.enabled_at!)).toBeGreaterThanOrEqual(Date.parse(enabledAt!));
	});

	it('uses the registration URL id as the admin-visible registration code', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		const created = await repository.createRegistrationUrl({
			label: 'Support invite',
			createdByUserId: '1500000000000000000',
			expiresAt: null,
			maxUses: null,
			approvalRequired: false,
		});

		expect(created.code).toBe(created.registrationUrl.id);
		expect(created.registrationUrl).not.toHaveProperty('code_hash');
		await expect(repository.resolveRegistrationUrlCode(created.registrationUrl.id)).resolves.toMatchObject({
			id: created.registrationUrl.id,
		});
	});
});
