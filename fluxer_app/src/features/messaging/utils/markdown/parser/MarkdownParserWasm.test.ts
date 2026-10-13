// SPDX-License-Identifier: AGPL-3.0-or-later

import {ParserFlags} from '@app/features/messaging/utils/markdown/parser/Enums';
import {parseMarkdownAstWithWasm} from '@app/features/messaging/utils/markdown/parser/MarkdownParserWasm';
import {describe, expect, it} from 'vitest';

describe('migrated historical mention text', () => {
	const flags =
		ParserFlags.ALLOW_USER_MENTIONS |
		ParserFlags.ALLOW_ROLE_MENTIONS |
		ParserFlags.ALLOW_CHANNEL_MENTIONS |
		ParserFlags.ALLOW_MASKED_LINKS;
	it('parses destination identity tokens without treating explicit unknown labels as links or mentions', () => {
		const {nodes} = parseMarkdownAstWithWasm(
			'<@700> <@701> <@&800> <#200> [unmapped Discord user: 999] [unmapped Discord role: 998] [unmapped Discord channel: 997]',
			flags,
		);
		expect(nodes.filter((node) => node.type === 'Mention')).toEqual([
			{type: 'Mention', kind: {kind: 'User', id: '700'}},
			{type: 'Mention', kind: {kind: 'User', id: '701'}},
			{type: 'Mention', kind: {kind: 'Role', id: '800'}},
			{type: 'Mention', kind: {kind: 'Channel', id: '200'}},
		]);
		expect(nodes.some((node) => node.type === 'Link')).toBe(false);
		expect(JSON.stringify(nodes)).toContain('unmapped Discord user: 999');
	});
});

describe('markdown parser wasm blockquotes', () => {
	it('preserves consecutive empty blockquote lines', () => {
		expect(parseMarkdownAstWithWasm('> \n>  \nsome text', ParserFlags.ALLOW_BLOCKQUOTES)).toEqual({
			nodes: [
				{
					type: 'Blockquote',
					children: [],
					blankLines: 2,
				},
				{
					type: 'Text',
					content: 'some text',
				},
			],
		});
	});

	it('keeps a bare greater-than line as text', () => {
		expect(parseMarkdownAstWithWasm('> \n>', ParserFlags.ALLOW_BLOCKQUOTES)).toEqual({
			nodes: [
				{
					type: 'Blockquote',
					children: [],
					blankLines: 1,
				},
				{
					type: 'Text',
					content: '>',
				},
			],
		});
	});
});

describe('markdown parser wasm headings', () => {
	it('preserves presentation-only heading lines as block headings', () => {
		expect(parseMarkdownAstWithWasm('# ‎ \n# ‎', ParserFlags.ALLOW_HEADINGS)).toEqual({
			nodes: [
				{
					type: 'Heading',
					level: 1,
					children: [{type: 'Text', content: '‎ '}],
				},
				{
					type: 'Heading',
					level: 1,
					children: [{type: 'Text', content: '‎'}],
				},
			],
		});
	});

	it('keeps ordinary whitespace-only heading syntax as text', () => {
		expect(parseMarkdownAstWithWasm('# ', ParserFlags.ALLOW_HEADINGS)).toEqual({
			nodes: [{type: 'Text', content: '# '}],
		});
	});
});
