import { describe, it, expect } from 'vitest';
import { computeTrayMenuModel, describeInvalidJoinUrl } from '../../src/ui/tray-join-url.js';

describe('computeTrayMenuModel', () => {
  it('hides the section when nothing is active', () => {
    expect(computeTrayMenuModel({ state: 'inactive' }, { state: 'inactive' })).toEqual({
      kind: 'hidden',
    });
  });

  it('returns leader-copy with the join URL when the leader is healthy', () => {
    const model = computeTrayMenuModel(
      { state: 'leader', session: { joinUrl: 'https://www.sliccy.ai/join/abc.def' } },
      { state: 'inactive' }
    );
    expect(model).toEqual({
      kind: 'leader-copy',
      joinUrl: 'https://www.sliccy.ai/join/abc.def',
      label: 'Enable multi-browser sync',
      caption: 'Share this URL to connect more browsers.',
    });
  });

  it('returns leader-pending while the leader is connecting', () => {
    const model = computeTrayMenuModel(
      { state: 'connecting', session: null },
      { state: 'inactive' }
    );
    expect(model).toMatchObject({ kind: 'leader-pending', label: 'Multi-browser sync' });
    expect((model as { caption: string }).caption).toMatch(/Setting up/);
  });

  it('returns leader-pending with the error caption when the leader errored', () => {
    const model = computeTrayMenuModel(
      { state: 'error', session: null, error: 'Sync hub 503' },
      { state: 'inactive' }
    );
    expect(model).toEqual({
      kind: 'leader-pending',
      label: 'Multi-browser sync',
      caption: 'Sync hub 503',
    });
  });

  it('falls back to follower display when only the follower is active', () => {
    const model = computeTrayMenuModel(
      { state: 'inactive' },
      { state: 'connected', error: null, lastError: null }
    );
    expect(model).toEqual({
      kind: 'follower',
      label: 'Multi-browser sync',
      caption: 'Connected — mirroring another browser.',
    });
  });

  it('describes follower connecting state without leaking jargon', () => {
    const model = computeTrayMenuModel(
      { state: 'inactive' },
      { state: 'connecting', error: null, lastError: null }
    );
    expect((model as { caption: string }).caption).toMatch(/Connecting to the other browser/);
  });

  it('surfaces the follower error when present', () => {
    const model = computeTrayMenuModel(
      { state: 'inactive' },
      { state: 'error', error: 'Sync hub unreachable' }
    );
    expect(model).toMatchObject({
      kind: 'follower',
      label: 'Multi-browser sync',
      caption: 'Sync hub unreachable',
    });
  });

  it('prefers leader status over follower status when both are active', () => {
    const model = computeTrayMenuModel(
      { state: 'leader', session: { joinUrl: 'https://www.sliccy.ai/join/x.y' } },
      { state: 'connected' }
    );
    expect(model.kind).toBe('leader-copy');
  });
});

describe('describeInvalidJoinUrl', () => {
  it('asks the user to paste something when the input is empty', () => {
    expect(describeInvalidJoinUrl('')).toMatch(/Paste a sync URL/);
    expect(describeInvalidJoinUrl('   ')).toMatch(/Paste a sync URL/);
  });

  it('reports a non-URL string clearly', () => {
    expect(describeInvalidJoinUrl('just some text')).toMatch(/doesn’t look like a URL/);
  });

  it('rejects non-http(s) protocols', () => {
    expect(describeInvalidJoinUrl('ftp://example.com/join/abc.def')).toMatch(
      /must start with https/
    );
  });

  it('flags URLs that lack a /join/ capability', () => {
    expect(describeInvalidJoinUrl('https://www.sliccy.ai/tray/abc')).toMatch(/missing the \/join/);
    expect(describeInvalidJoinUrl('https://www.sliccy.ai/')).toMatch(/missing the \/join/);
  });

  it('returns a generic malformed message for /join/ URLs that still fail to parse', () => {
    expect(describeInvalidJoinUrl('https://www.sliccy.ai/join/')).toMatch(/malformed|missing/);
  });

  it('does not surface tray/leader/follower jargon', () => {
    const samples = [
      describeInvalidJoinUrl(''),
      describeInvalidJoinUrl('not a url'),
      describeInvalidJoinUrl('ftp://example.com/join/abc.def'),
      describeInvalidJoinUrl('https://www.sliccy.ai/tray/abc'),
      describeInvalidJoinUrl('https://www.sliccy.ai/join/'),
    ];
    for (const msg of samples) {
      expect(msg.toLowerCase()).not.toMatch(/\btray\b|leader|follower/);
    }
  });
});
