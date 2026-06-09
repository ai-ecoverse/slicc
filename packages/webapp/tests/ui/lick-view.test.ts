// @vitest-environment jsdom

import { DoorOpen, Sparkles, Workflow } from 'lucide';
import { describe, expect, it } from 'vitest';
import { getLickDescriptor } from '../../src/ui/lick-view.js';
import type { ChatMessage } from '../../src/ui/types.js';

function makeLick(channel: string, content: string): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content,
    timestamp: Date.now(),
    source: 'lick',
    channel,
  };
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

  it('returns a non-default workflow descriptor for workflow completion licks', () => {
    const msg = makeLick('workflow', '[Workflow Event: my-flow]\n\ndone');
    const desc = getLickDescriptor(msg);
    expect(desc.label).toBe('workflow');
    // Must be the bespoke Workflow glyph, not the fallback Bell/'event'.
    expect(desc.label).not.toBe('event');
    expect(desc.icon).toBe(Workflow as unknown);
  });
});
