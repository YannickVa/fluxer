// SPDX-License-Identifier: AGPL-3.0-or-later

export interface SupportProblemReportInput {
	categoryLabel: string;
	description: string;
	expectedBehavior: string;
	willAttachScreenshot: boolean;
	supportSummary: string | null;
}

export function buildSupportProblemReport(input: SupportProblemReportInput): string | null {
	const description = input.description.trim();
	if (!description) return null;
	return [
		'**Problem report**',
		`**Category:** ${input.categoryLabel}`,
		`**What happened:** ${description}`,
		input.expectedBehavior.trim() ? `**What I expected:** ${input.expectedBehavior.trim()}` : null,
		`**Screenshot:** ${input.willAttachScreenshot ? 'I will attach one before sending.' : 'Not included.'}`,
		input.supportSummary ? `\n\`\`\`text\n${input.supportSummary}\n\`\`\`` : null,
	]
		.filter((line): line is string => line !== null)
		.join('\n\n');
}

export function appendSupportProblemReportToDraft(existingDraft: string, report: string): string {
	const existing = existingDraft.trim();
	return existing ? `${existing}\n\n---\n\n${report}` : report;
}
