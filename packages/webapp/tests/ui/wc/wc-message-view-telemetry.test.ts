// @vitest-environment jsdom
/**
 * `userMessageEl` fires `trackImageView('chat')` once per displayed image
 * attachment. The thread is rebuilt on every render (streaming, scoop switch,
 * replay) so this guards both the wiring and the per-attachment dedup.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

vi.mock('../../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/ui/telemetry.js')>(
    '../../../src/ui/telemetry.js'
  );
  return { ...actual, trackImageView: vi.fn() };
});

import { trackImageView } from '../../../src/ui/telemetry.js';
import type { ChatMessage } from '../../../src/ui/types.js';
import { messageEls } from '../../../src/ui/wc/wc-message-view.js';

function imageMessage(id: string, attachmentId: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: 'see attached',
    timestamp: 1,
    attachments: [
      {
        id: attachmentId,
        name: 'shot.png',
        mimeType: 'image/png',
        size: 4,
        kind: 'image',
        data: 'AAAA',
      },
    ],
  };
}

describe('userMessageEl — trackImageView wiring', () => {
  beforeEach(() => {
    vi.mocked(trackImageView).mockClear();
  });

  it('fires viewmedia with source=chat for an image attachment', () => {
    messageEls(imageMessage('m1', 'a1'));
    expect(trackImageView).toHaveBeenCalledTimes(1);
    expect(trackImageView).toHaveBeenCalledWith('chat');
  });

  it('does not double-fire on re-render of the same message', () => {
    const message = imageMessage('m2', 'a2');
    messageEls(message);
    messageEls(message);
    messageEls(message);
    expect(trackImageView).toHaveBeenCalledTimes(1);
  });

  it('fires once per distinct attachment within a message', () => {
    const message: ChatMessage = {
      id: 'm3',
      role: 'user',
      content: 'two images',
      timestamp: 1,
      attachments: [
        { id: 'a3a', name: 'a.png', mimeType: 'image/png', size: 4, kind: 'image', data: 'AAAA' },
        { id: 'a3b', name: 'b.png', mimeType: 'image/png', size: 4, kind: 'image', data: 'BBBB' },
      ],
    };
    messageEls(message);
    expect(trackImageView).toHaveBeenCalledTimes(2);
    // Re-render: still only the original two.
    messageEls(message);
    expect(trackImageView).toHaveBeenCalledTimes(2);
  });

  it('skips non-image attachments', () => {
    const message: ChatMessage = {
      id: 'm4',
      role: 'user',
      content: 'a text file',
      timestamp: 1,
      attachments: [
        {
          id: 'a4',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 4,
          kind: 'text',
          text: 'hi',
        },
      ],
    };
    messageEls(message);
    expect(trackImageView).not.toHaveBeenCalled();
  });

  it('skips image attachments with no inlined data', () => {
    const message: ChatMessage = {
      id: 'm5',
      role: 'user',
      content: 'image too large to inline',
      timestamp: 1,
      attachments: [
        {
          id: 'a5',
          name: 'big.png',
          mimeType: 'image/png',
          size: 999999,
          kind: 'image',
          path: '/tmp/big.png',
        },
      ],
    };
    messageEls(message);
    expect(trackImageView).not.toHaveBeenCalled();
  });
});
