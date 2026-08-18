// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {createRoomConnectOptions} from './VoiceEngineV2AppLiveKitConnectOptions';

describe('createRoomConnectOptions', () => {
	it('allows LiveKit to use direct ICE candidates', () => {
		expect(createRoomConnectOptions()).toEqual({autoSubscribe: false});
	});
});
