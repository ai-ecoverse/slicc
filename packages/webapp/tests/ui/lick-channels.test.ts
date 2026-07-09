import { describe, expect, it } from 'vitest';
import { isLickChannel, LICK_CHANNELS } from '../../src/ui/lick-channels.js';

describe('isLickChannel', () => {
  it('recognizes the SP2 workflow completion channel as a lick', () => {
    // Regression: a `'workflow'` completion lick arrives via
    // orchestrator.handleMessage as a channel:'workflow' message with no
    // source:'lick'. The chat panel decides lick-widget rendering via
    // isLickChannel(msg.channel); if 'workflow' is missing from the UI
    // channel set it renders as a plain chat bubble instead of a lick
    // widget. See SP2 (workflow background runs).
    expect(isLickChannel('workflow')).toBe(true);
    expect(LICK_CHANNELS.has('workflow')).toBe(true);
  });

  it('recognizes the existing external + lifecycle channels', () => {
    for (const channel of ['webhook', 'cron', 'sprinkle', 'scoop-notify']) {
      expect(isLickChannel(channel)).toBe(true);
    }
  });

  it('recognizes the discovery channel as a lick', () => {
    // A `.well-known` probe (llms.txt / ai-catalog.json) delivers a
    // `channel: 'discovery'` message to the cone. Live UI rendering decides
    // lick-widget treatment via isLickChannel(message.channel); if
    // 'discovery' is missing from the UI channel set it renders as a plain
    // chat bubble instead of a collapsible lick card.
    expect(isLickChannel('discovery')).toBe(true);
    expect(LICK_CHANNELS.has('discovery')).toBe(true);
  });

  it('recognizes the scoop sudo escalation channel as a lick', () => {
    // The orchestrator's `deliverSudoRequestToCone` builds a
    // `channel: 'sudo-request'` ChannelMessage so a pending escalation
    // renders as a "Scoop Access Request" lick chip (key-round icon) instead
    // of a plain chat bubble. Live UI rendering goes through
    // `isLickChannel(message.channel)` in `wc-live.ts`'s `onIncomingMessage`.
    expect(isLickChannel('sudo-request')).toBe(true);
    expect(LICK_CHANNELS.has('sudo-request')).toBe(true);
  });

  it('rejects non-lick channels and nullish input', () => {
    expect(isLickChannel('web')).toBe(false);
    expect(isLickChannel('not-a-channel')).toBe(false);
    expect(isLickChannel(null)).toBe(false);
    expect(isLickChannel(undefined)).toBe(false);
  });
});
