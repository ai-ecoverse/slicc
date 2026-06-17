import { describe, expect, it } from 'vitest';
import { applyDictationMarkers } from '../../src/speech/dictation-priming.js';
import { formatChatForClipboard } from '../../src/ui/chat-clipboard.js';
import type { ChatMessage } from '../../src/ui/types.js';

const MIC = '\uD83C\uDF99\uFE0F';
const LEFT = '\u25C1';
const RIGHT = '\u25B7';

function userMessage(content: string): ChatMessage {
  return { id: 'u', role: 'user', content, timestamp: 1 };
}
function assistantMessage(content: string): ChatMessage {
  return { id: 'a', role: 'assistant', content, timestamp: 2 };
}

describe('formatChatForClipboard', () => {
  it('strips 🎙️ + ◁…▷ markers from a dictated user message (first turn)', () => {
    const dictated = applyDictationMarkers('Hello world', true);
    expect(dictated).toContain(MIC);
    expect(dictated).toContain(LEFT);
    expect(dictated).toContain(RIGHT);

    const out = formatChatForClipboard([userMessage(dictated), assistantMessage('Hi back')]);
    expect(out).toContain('## User\nHello world\n');
    expect(out).not.toContain(MIC);
    expect(out).not.toContain(LEFT);
    expect(out).not.toContain(RIGHT);
  });

  it('strips a bare 🎙️ from a later dictated user message', () => {
    const dictated = applyDictationMarkers('Try again', false);
    const out = formatChatForClipboard([userMessage(dictated)]);
    expect(out).toBe('## User\nTry again\n\n');
  });

  it('leaves assistant content untouched even if it contains a 🎙️-like glyph', () => {
    // Assistants never receive the markers in practice, but the contract is
    // "only user role is stripped" — guard against accidental stripping of
    // assistant text that happens to mention the glyph.
    const assistantText = `Sure — your microphone (${MIC}) is muted`;
    const out = formatChatForClipboard([assistantMessage(assistantText)]);
    expect(out).toContain(MIC);
    expect(out).toContain(assistantText);
  });

  it('passes typed (non-dictated) user messages through verbatim', () => {
    const typed = 'Plain typed prompt — no markers.';
    const out = formatChatForClipboard([userMessage(typed)]);
    expect(out).toBe(`## User\n${typed}\n\n`);
  });

  it('preserves attachments + toolCalls sections around stripped user content', () => {
    const dictated = applyDictationMarkers('Check this file', false);
    const msg: ChatMessage = {
      id: 'u',
      role: 'user',
      content: dictated,
      timestamp: 1,
      attachments: [
        {
          id: 'att-1',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 12,
          kind: 'text',
          text: 'hello world\n',
        },
      ],
    };
    const out = formatChatForClipboard([msg]);
    expect(out).toContain('## User\nCheck this file\n');
    expect(out).not.toContain(MIC);
    expect(out).toContain('Attachments:');
    expect(out).toContain('notes.txt');
  });
});
