// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import type {RoomConnectOptions} from 'livekit-client';

export function createRoomConnectOptions(): RoomConnectOptions {
	const connectOptions: RoomConnectOptions = {
		autoSubscribe: false,
	};
	assert.equal(connectOptions.autoSubscribe, false, 'LiveKit connect options must not auto-subscribe');
	return connectOptions;
}
