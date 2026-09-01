// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {appendSupportProblemReportToDraft, buildSupportProblemReport} from './SupportProblemReport';

describe('SupportProblemReport', () => {
	it('requires a meaningful description', () => {
		expect(
			buildSupportProblemReport({
				categoryLabel: 'Technical',
				description: '   ',
				expectedBehavior: '',
				willAttachScreenshot: false,
				supportSummary: null,
			}),
		).toBeNull();
	});

	it('includes only the optional details the user chose', () => {
		const report = buildSupportProblemReport({
			categoryLabel: 'Voice or video problem',
			description: ' Camera preview is black. ',
			expectedBehavior: ' The preview should show video. ',
			willAttachScreenshot: true,
			supportSummary: 'Build: test',
		});
		expect(report).toContain('**What happened:** Camera preview is black.');
		expect(report).toContain('**What I expected:** The preview should show video.');
		expect(report).toContain('I will attach one before sending.');
		expect(report).toContain('```text\nBuild: test\n```');
	});

	it('preserves an existing channel draft', () => {
		expect(appendSupportProblemReportToDraft('my existing note', 'new report')).toBe(
			'my existing note\n\n---\n\nnew report',
		);
		expect(appendSupportProblemReportToDraft('', 'new report')).toBe('new report');
	});
});
