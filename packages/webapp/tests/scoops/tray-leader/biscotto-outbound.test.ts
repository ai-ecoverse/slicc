/**
 * A guest's channel must not be able to carry a message it may not receive,
 * whoever writes to it. Enforced at the channel rather than at each broadcast
 * site, because there are many senders and patching them one at a time is how
 * the next one added starts leaking.
 */
import type { LeaderToFollowerMessage } from '@slicc/shared-ts';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import {
  BISCOTTO_RECEIVABLE,
  isMessageSendableToTrust,
} from '../../../src/scoops/tray-leader/biscotto-gate.js';
import { FollowerRegistry } from '../../../src/scoops/tray-leader/follower-registry.js';
import type { TrayDataChannelLike } from '../../../src/scoops/tray-webrtc.js';

const EXPECTED_RECEIVABLE = [
  'agent_event',
  'biscotto.message.state',
  'error',
  'hello',
  'ping',
  'pong',
  'snapshot',
  'snapshot_chunk',
  'status',
  'theme.apply',
  'user_message_echo',
];

function channel(): TrayDataChannelLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    readyState: 'open',
    send: (data: string) => sent.push(data),
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
  } as unknown as TrayDataChannelLike & { sent: string[] };
}

function registry() {
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new FollowerRegistry({ log, onMessage: vi.fn() });
}

describe('BISCOTTO_RECEIVABLE', () => {
  it('permits exactly the shared-thread message set', () => {
    const allowed = Object.entries(BISCOTTO_RECEIVABLE)
      .filter(([, ok]) => ok)
      .map(([type]) => type)
      .sort();
    expect(allowed).toEqual(EXPECTED_RECEIVABLE);
  });

  it('withholds everything outside the seat’s one transcript', () => {
    for (const type of [
      'scoops.list',
      'targets.registry',
      'preview.open',
      'models.list',
      'sudo.approve.request',
      'oauth.popup.request',
      'transcript.export.start',
      'sprinkles.list',
    ] satisfies LeaderToFollowerMessage['type'][]) {
      expect(isMessageSendableToTrust('biscotto', type)).toBe(false);
    }
  });

  it('leaves a full-trust follower unrestricted', () => {
    for (const type of Object.keys(BISCOTTO_RECEIVABLE) as LeaderToFollowerMessage['type'][]) {
      expect(isMessageSendableToTrust('full', type)).toBe(true);
    }
  });
});

describe('the seat channel enforces it', () => {
  it('drops a withheld message even when sent directly at the follower', () => {
    const reg = registry();
    const ch = channel();
    const follower = reg.addFollower('peer', ch, { trust: 'biscotto' });

    // The inventory of everything else the owner is working on.
    follower.sync.send({ type: 'scoops.list', scoops: [], activeScoopJid: 'cone' } as never);
    // Browser tab titles and URLs.
    follower.sync.send({ type: 'targets.registry', targets: [] } as never);
    // A live capability URL.
    follower.sync.send({ type: 'preview.open', requestId: 'p1', url: 'https://x' } as never);

    expect(ch.sent).toHaveLength(0);
  });

  it('still delivers the shared thread', () => {
    const reg = registry();
    const ch = channel();
    const follower = reg.addFollower('peer', ch, { trust: 'biscotto' });

    follower.sync.send({ type: 'snapshot', messages: [], scoopJid: 'cone' } as never);
    expect(ch.sent).toHaveLength(1);
  });

  it('reports a withheld send as success, not as a transport failure', () => {
    // The caller is broadcasting to everyone; a guest legitimately not
    // receiving something is not an error worth surfacing.
    const reg = registry();
    const follower = reg.addFollower('peer', channel(), { trust: 'biscotto' });
    expect(follower.sync.send({ type: 'scoops.list', scoops: [] } as never)).toBe(true);
  });

  it('does not touch a full-trust follower’s channel', () => {
    const reg = registry();
    const ch = channel();
    const follower = reg.addFollower('peer', ch, { trust: 'full' });
    follower.sync.send({ type: 'scoops.list', scoops: [], activeScoopJid: 'cone' } as never);
    expect(ch.sent).toHaveLength(1);
  });
});
