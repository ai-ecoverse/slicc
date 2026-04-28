import { describe, expect, it } from 'vitest';
import {
  formatPromptWithAttachments,
  imageContentFromAttachments,
} from '../../src/core/attachments.js';
import type { MessageAttachment } from '../../src/core/attachments.js';

describe('attachment prompt formatting', () => {
  it('keeps image attachments as image content and adds a prompt summary', () => {
    const attachments: MessageAttachment[] = [
      {
        id: 'a1',
        name: 'shot.png',
        mimeType: 'image/png',
        size: 12,
        kind: 'image',
        data: 'abc123',
      },
    ];

    expect(formatPromptWithAttachments('describe this', attachments)).toContain(
      '[Attached image: shot.png (image/png, 12 B)]'
    );
    expect(imageContentFromAttachments(attachments)).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'abc123' },
    ]);
  });

  it('inlines text attachments into the prompt', () => {
    const prompt = formatPromptWithAttachments('', [
      {
        id: 'a1',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        kind: 'text',
        text: 'hello',
      },
    ]);

    expect(prompt).toContain('BEGIN ATTACHMENT notes.txt');
    expect(prompt).toContain('hello');
    expect(imageContentFromAttachments([])).toEqual([]);
  });
});
