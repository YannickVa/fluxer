// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {validateCapturedAvatarImage} from '../AvatarColorUtils';

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);
const gif = Buffer.from('R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

describe('captured avatar decoding', () => {
	it('accepts decoded PNG and GIF payloads', async () => {
		await expect(validateCapturedAvatarImage(png, 'png')).resolves.toBeUndefined();
		await expect(validateCapturedAvatarImage(gif, 'gif')).resolves.toBeUndefined();
	});
	it('refuses a valid image in a different declared format', async () => {
		await expect(validateCapturedAvatarImage(png, 'gif')).rejects.toThrow('declared format');
		await expect(validateCapturedAvatarImage(gif, 'png')).rejects.toThrow('declared format');
	});
	it('refuses truncated payloads despite plausible image signatures', async () => {
		await expect(validateCapturedAvatarImage(png.subarray(0, 12), 'png')).rejects.toThrow('cannot be decoded');
		await expect(validateCapturedAvatarImage(gif.subarray(0, 6), 'gif')).rejects.toThrow('cannot be decoded');
	});
	it('returns a redacted error for arbitrary private/non-image input', async () => {
		const error = await validateCapturedAvatarImage(Buffer.from('private synthetic metadata'), 'png').catch(
			(error) => error,
		);
		expect(error.message).toBe('Avatar gate: captured image cannot be decoded in its declared format.');
	});
});
