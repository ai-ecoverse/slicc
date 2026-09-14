import { describe, expect, it } from 'vitest';
import { isLickChannel, LICK_CHANNELS } from '../../src/base/lick-channels.js';

describe('isLickChannel', () => {
  it('recognizes the SP2 workflow completion channel as a lick', () => {
    expect(isLickChannel('workflow')).toBe(true);
    expect(LICK_CHANNELS.has('workflow')).toBe(true);
  });

  it('recognizes the existing external + lifecycle channels', () => {
    for (const channel of ['webhook', 'cron', 'sprinkle', 'scoop-notify']) {
      expect(isLickChannel(channel)).toBe(true);
    }
  });

  it('recognizes the discovery channel as a lick', () => {
    expect(isLickChannel('discovery')).toBe(true);
    expect(LICK_CHANNELS.has('discovery')).toBe(true);
  });

  it('recognizes preview lifecycle announcements as licks', () => {
    expect(isLickChannel('preview')).toBe(true);
    expect(LICK_CHANNELS.has('preview')).toBe(true);
  });

  it('recognizes the scoop sudo escalation channel as a lick', () => {
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
