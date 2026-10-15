import { describe, expect, it } from 'vitest';
import {
  lickChannelFromBody,
  lickChannelFromSenderName,
  lickIdFromBody,
  splitEnvelopes,
  unwrapMessageEnvelope,
} from '../../src/base/message-envelope.js';

/**
 * The envelope/lick parsing grammar lives in `base/` so both the Scoops
 * chat translator and the lower WorkUnit record ingest can read it without
 * a `work-unit/ ↔ scoops/` runtime cycle (#3995). These tests pin the
 * parsers at their new home; the ChatMessage-construction tests in
 * `tests/scoops/agent-message-to-chat.test.ts` still exercise them through
 * the re-export.
 */
describe('unwrapMessageEnvelope', () => {
  it('strips a plain User envelope', () => {
    expect(unwrapMessageEnvelope('[May 11, 6:50 AM] User: hi')).toEqual({
      sender: 'User',
      body: 'hi',
    });
  });

  it('anchors on the channel prefix for senders containing ": "', () => {
    const raw = '[May 11, 10:00 AM] webhook:deploy: prod: [Webhook Event: deploy: prod]\nbody';
    expect(unwrapMessageEnvelope(raw)).toEqual({
      sender: 'webhook:deploy: prod',
      body: '[Webhook Event: deploy: prod]\nbody',
    });
  });

  it('returns null when the bracketed prefix spans a newline', () => {
    expect(unwrapMessageEnvelope('[opens here\nbut keeps going] User: bogus')).toBeNull();
  });

  it('returns null for non-bracketed text', () => {
    expect(unwrapMessageEnvelope('just text')).toBeNull();
  });
});

describe('splitEnvelopes', () => {
  it('returns a single unenveloped segment for plain text', () => {
    expect(splitEnvelopes('plain body')).toEqual([{ sender: null, body: 'plain body' }]);
  });

  it('splits a batched user message into separate envelopes', () => {
    const raw =
      '[May 11, 8:15 AM] sprinkle:welcome: [Sprinkle Event: welcome]\n' +
      '[May 11, 8:16 AM] User: typed input';
    expect(splitEnvelopes(raw)).toEqual([
      { sender: 'sprinkle:welcome', body: '[Sprinkle Event: welcome]' },
      { sender: 'User', body: 'typed input' },
    ]);
  });

  it('does not start a new envelope on an inner bracket-shaped body line', () => {
    const raw = '[May 11, 8:15 AM] sprinkle:welcome: header\n[Sprinkle Event: welcome]\nmore body';
    expect(splitEnvelopes(raw)).toEqual([
      { sender: 'sprinkle:welcome', body: 'header\n[Sprinkle Event: welcome]\nmore body' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(splitEnvelopes('')).toEqual([]);
  });
});

describe('lickChannelFromSenderName', () => {
  it('maps a channel-prefixed sender back to its LickChannel', () => {
    expect(lickChannelFromSenderName('cron:daily')).toBe('cron');
  });

  it('returns null for plain user senders', () => {
    expect(lickChannelFromSenderName('User')).toBeNull();
    expect(lickChannelFromSenderName('not-a-channel:x')).toBeNull();
  });
});

describe('lickChannelFromBody', () => {
  it('classifies scoop lifecycle bodies with no sender channel prefix', () => {
    expect(lickChannelFromBody('[@tool-demo-scoop completed]VFS path: /shared/x')).toBe(
      'scoop-notify'
    );
    expect(lickChannelFromBody('[@pomodoro-scoop idle]: ready')).toBe('scoop-idle');
    expect(lickChannelFromBody('[@s sudo-request]\nKind: command')).toBe('sudo-request');
    expect(lickChannelFromBody('[scoop_wait completed]1 completed, 0 timed out')).toBe(
      'scoop-wait'
    );
    expect(lickChannelFromBody('[Session Reload] Mount recovery required.')).toBe('session-reload');
    expect(lickChannelFromBody('plain user text')).toBeNull();
  });
});

describe('lickIdFromBody', () => {
  it('recovers a lick id from the Lick ID / Request ID line', () => {
    expect(lickIdFromBody('[@s sudo-request]\nLick ID: lick-1\nKind: command')).toBe('lick-1');
    expect(lickIdFromBody('[@s sudo-request]\nRequest ID: sudo-abc\nKind: command')).toBe(
      'sudo-abc'
    );
    expect(lickIdFromBody('no id here')).toBeUndefined();
  });
});
