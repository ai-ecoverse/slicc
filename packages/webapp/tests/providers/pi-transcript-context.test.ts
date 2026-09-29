import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { describe, expect, it } from 'vitest';
import {
  toLegacyPiContext,
  toPiTranscriptContext,
} from '../../src/providers/pi-transcript-context.js';

describe('Pi transcript compatibility', () => {
  it('normalizes a legacy provider call once', () => {
    const context = { systemPrompt: 'Be concise', messages: [], tools: [] };
    const transcript = toPiTranscriptContext(context);
    expect(transcript.messages[0]).toMatchObject({ role: 'system', content: 'Be concise' });
    expect(toPiTranscriptContext(transcript)).toBe(transcript);
  });

  it('replays later prompt and tool changes for a legacy wire adapter', () => {
    const tool = {
      name: 'screenshot',
      description: 'Capture a page',
      parameters: { type: 'object' as const, properties: {} },
    };
    const transcript = normalizeContext({
      systemPrompt: 'Base',
      tools: [tool],
      messages: [
        { role: 'user', content: 'Look', timestamp: 1 },
        {
          role: 'system',
          content: 'Use the image',
          toolsRemoved: [{ name: 'screenshot' }],
          timestamp: 2,
        },
      ],
    });
    expect(toLegacyPiContext(transcript)).toEqual({
      systemPrompt: 'Base\n\nUse the image',
      tools: [],
      messages: [{ role: 'user', content: 'Look', timestamp: 1 }],
    });
  });
});
