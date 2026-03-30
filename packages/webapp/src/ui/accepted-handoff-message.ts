import type { PendingHandoff } from '../../../chrome-extension/src/messages.js';
import { getHandoffSourcePageUrl } from '../../../chrome-extension/src/handoff-shared.js';

export function formatAcceptedHandoffMessage(handoff: PendingHandoff): string {
  const sections: string[] = [];
  const { payload } = handoff;

  if (payload.title) sections.push(`# ${payload.title}`);
  sections.push(`A new handoff was accepted from ${getHandoffSourcePageUrl(handoff.sourceUrl)}.`);
  sections.push('## Instruction');
  sections.push(payload.instruction);

  if (payload.urls && payload.urls.length > 0) {
    sections.push('## URLs');
    for (const url of payload.urls) sections.push(`- ${url}`);
  }

  if (payload.context) {
    sections.push('## Context');
    sections.push(payload.context);
  }

  if (payload.acceptanceCriteria && payload.acceptanceCriteria.length > 0) {
    sections.push('## Acceptance Criteria');
    for (const item of payload.acceptanceCriteria) sections.push(`- ${item}`);
  }

  if (payload.notes) {
    sections.push('## Notes');
    sections.push(payload.notes);
  }

  return sections.join('\n\n');
}
