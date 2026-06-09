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

  it('rejects non-lick channels and nullish input', () => {
    expect(isLickChannel('web')).toBe(false);
    expect(isLickChannel('not-a-channel')).toBe(false);
    expect(isLickChannel(null)).toBe(false);
    expect(isLickChannel(undefined)).toBe(false);
  });
});
