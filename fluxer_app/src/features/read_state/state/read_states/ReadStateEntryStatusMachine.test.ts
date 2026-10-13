// SPDX-License-Identifier: AGPL-3.0-or-later

import {fromTimestamp} from '@fluxer/snowflake/src/SnowflakeUtils';
import {describe, expect, it} from 'vitest';
import {type ReadStateEntryStatusInput, resolveReadStateEntryStatus} from './ReadStateEntryStatusMachine';

const BASE_TIMESTAMP = Date.UTC(2024, 0, 1);
const ACK_ID = fromTimestamp(BASE_TIMESTAMP + 1000);
const LAST_ID = fromTimestamp(BASE_TIMESTAMP + 2000);

function input(overrides: Partial<ReadStateEntryStatusInput> = {}): ReadStateEntryStatusInput {
	return {
		supportsUnreadTracking: true,
		hasBlockedDirectMessageRecipient: false,
		ackTimestamp: BASE_TIMESTAMP,
		lastMessageTimestamp: BASE_TIMESTAMP,
		lastMessageId: LAST_ID,
		ackMessageId: LAST_ID,
		mentionCount: 0,
		...overrides,
	};
}

function expectResolvedState(
	overrides: Partial<ReadStateEntryStatusInput>,
	expected: ReturnType<typeof resolveReadStateEntryStatus>['state'],
): void {
	expect(resolveReadStateEntryStatus(input(overrides)).state).toBe(expected);
}

describe('readStateEntryStatusMachine', () => {
	it('keeps imported history read with no badges while subsequent live messages become unread', () => {
		const imported = resolveReadStateEntryStatus(
			input({ackMessageId: LAST_ID, lastMessageId: LAST_ID, mentionCount: 0}),
		);
		expect(imported).toMatchObject({state: 'read', hasUnread: false, hasMentions: false});
		const live = resolveReadStateEntryStatus(
			input({ackMessageId: LAST_ID, lastMessageId: fromTimestamp(BASE_TIMESTAMP + 3000), mentionCount: 1}),
		);
		expect(live).toMatchObject({state: 'unread', hasUnread: true, hasMentions: true});
	});
	it('routes the read-state status by priority', () => {
		expectResolvedState({supportsUnreadTracking: false, mentionCount: 1, ackMessageId: ACK_ID}, 'untracked');
		expectResolvedState({hasBlockedDirectMessageRecipient: true, mentionCount: 1, ackMessageId: ACK_ID}, 'blocked');
		expectResolvedState({lastMessageId: null, ackMessageId: ACK_ID}, 'read');
		expectResolvedState({ackMessageId: ACK_ID}, 'unread');
		expectResolvedState({ackMessageId: LAST_ID}, 'read');
	});

	it('derives unread and mention capabilities from the routed state', () => {
		expect(resolveReadStateEntryStatus(input({ackMessageId: ACK_ID, mentionCount: 2}))).toMatchObject({
			state: 'unread',
			canBeUnread: true,
			supportsMentions: true,
			hasUnread: true,
			hasMentions: true,
			isUnreadOrMentioned: true,
		});
		expect(resolveReadStateEntryStatus(input({hasBlockedDirectMessageRecipient: true, mentionCount: 2}))).toMatchObject(
			{
				state: 'blocked',
				canBeUnread: true,
				supportsMentions: false,
				hasUnread: false,
				hasMentions: true,
				isUnreadOrMentioned: false,
			},
		);
		expect(resolveReadStateEntryStatus(input({supportsUnreadTracking: false, mentionCount: 2}))).toMatchObject({
			state: 'untracked',
			canBeUnread: false,
			supportsMentions: false,
			hasUnread: false,
			hasMentions: true,
			isUnreadOrMentioned: false,
		});
	});
});
