import { describe, expect, it } from 'vitest';
import { formatAcceptedHandoffMessage } from '../../src/ui/accepted-handoff-message.js';

describe('formatAcceptedHandoffMessage', () => {
  it('uses the real fragment-stripped handoff page URL', () => {
    const message = formatAcceptedHandoffMessage({
      handoffId: 'handoff-1',
      sourceUrl:
        'https://slicc-tray-hub-staging.minivelos.workers.dev/handoff#eyJpbnN0cnVjdGlvbiI6InRlc3QifQ',
      receivedAt: '2026-03-29T12:00:00.000Z',
      payload: {
        title: 'Investigate staging',
        instruction: 'Continue in SLICC.',
        urls: ['https://example.com'],
      },
    });

    expect(message).toContain(
      'A new handoff was accepted from https://slicc-tray-hub-staging.minivelos.workers.dev/handoff.'
    );
    expect(message).not.toContain('#eyJpbnN0cnVjdGlvbiI6InRlc3QifQ');
  });
});
