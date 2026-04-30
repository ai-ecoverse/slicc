// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { DoorOpen, Sparkles } from 'lucide';
import { getLickDescriptor } from '../../src/ui/lick-view.js';
import type { ChatMessage } from '../../src/ui/types.js';

function makeLick(channel: string, content: string): ChatMessage {
  return {
    id: 'm1',
    chatJid: 'cone',
    senderId: channel,
    senderName: `${channel}:test`,
    content,
    timestamp: new Date().toISOString(),
    fromAssistant: false,
    channel,
  } as ChatMessage;
}

describe('getLickDescriptor', () => {
  it('returns the DoorOpen icon for welcome sprinkle licks', () => {
    const msg = makeLick('sprinkle', '[Sprinkle Event: welcome]\n\nFirst run');
    const desc = getLickDescriptor(msg);
    // DoorOpen is the open-door glyph — use identity comparison via the
    // icon node payload to avoid coupling to an internal export shape.
    expect(desc.icon).toBe(DoorOpen as unknown);
    expect(desc.label).toBe('sprinkle');
  });

  it('falls back to Sparkles for other sprinkle names', () => {
    const msg = makeLick('sprinkle', '[Sprinkle Event: tasks]\n\nbody');
    const desc = getLickDescriptor(msg);
    expect(desc.icon).toBe(Sparkles as unknown);
  });

  it('returns Sparkles when the sprinkle header is missing', () => {
    const msg = makeLick('sprinkle', 'no header here');
    const desc = getLickDescriptor(msg);
    expect(desc.icon).toBe(Sparkles as unknown);
  });
});
