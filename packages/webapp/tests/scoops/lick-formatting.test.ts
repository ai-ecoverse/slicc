import { describe, it, expect } from 'vitest';
import { formatLickEventForCone } from '../../src/scoops/lick-formatting.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';

describe('formatLickEventForCone', () => {
  it('returns null when session-reload mount-recovery list is empty', () => {
    const event = {
      type: 'session-reload',
      timestamp: '2026-04-30T12:00:00Z',
      body: { reason: 'mount-recovery', mounts: [] },
    } as unknown as LickEvent;
    expect(formatLickEventForCone(event)).toBeNull();
  });

  it('formats session-reload mount-recovery with local + s3 entries', () => {
    const event = {
      type: 'session-reload',
      timestamp: '2026-04-30T12:00:00Z',
      body: {
        reason: 'mount-recovery',
        mounts: [
          { kind: 'local', path: '/mnt/x', dirName: 'x' },
          {
            kind: 's3',
            path: '/mnt/r2',
            source: 's3://b/p',
            profile: 'r2',
            reason: 'expired',
          },
        ],
      },
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out).not.toBeNull();
    expect(out!.label).toBe('Session Reload');
    expect(out!.content).toContain('/mnt/x');
    expect(out!.content).toContain('/mnt/r2');
    expect(out!.content).toContain("mount --source 's3://b/p' --profile 'r2' '/mnt/r2'");
  });

  it('formats upgrade events with version arrow and changelog hint', () => {
    const event = {
      type: 'upgrade',
      upgradeFromVersion: '0.1.0',
      upgradeToVersion: '0.2.0',
      timestamp: '2026-04-30T12:00:00Z',
      body: { releasedAt: '2026-04-29T00:00:00Z' },
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out).not.toBeNull();
    expect(out!.label).toBe('Upgrade Event');
    expect(out!.content).toContain('0.1.0→0.2.0');
    expect(out!.content).toContain('SLICC was upgraded from `0.1.0` to `0.2.0`');
    expect(out!.content).toContain('Released: 2026-04-29T00:00:00Z');
    expect(out!.content).toContain('upgrade');
  });

  it('upgrade with no releasedAt omits the Released: line', () => {
    const event = {
      type: 'upgrade',
      upgradeFromVersion: '0.1.0',
      upgradeToVersion: '0.2.0',
      body: {},
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out!.content).not.toContain('Released:');
  });

  it('formats webhook events as JSON block', () => {
    const event = {
      type: 'webhook',
      webhookName: 'foo',
      webhookId: 'wh-1',
      timestamp: '2026-04-30T12:00:00Z',
      body: { hello: 'world' },
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out).not.toBeNull();
    expect(out!.label).toBe('Webhook Event');
    expect(out!.content).toContain('[Webhook Event: foo]');
    expect(out!.content).toContain('"hello"');
    expect(out!.content).toContain('"world"');
  });

  it('formats cron events as JSON block (default fallback)', () => {
    const event = {
      type: 'cron',
      cronName: 'nightly',
      cronId: 'c-1',
      body: { foo: 1 },
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out!.label).toBe('Cron Event');
    expect(out!.content).toContain('[Cron Event: nightly]');
  });

  it('formats fswatch events with file-watch label', () => {
    const event = {
      type: 'fswatch',
      fswatchName: 'workspace-watcher',
      fswatchId: 'fs-1',
      body: { changes: [] },
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out!.label).toBe('File Watch Event');
  });

  it('formats navigate events with url as the eventName', () => {
    const event = {
      type: 'navigate',
      navigateUrl: 'https://example.test/page',
      body: { foo: 1 },
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out!.label).toBe('Navigate Event');
    expect(out!.content).toContain('https://example.test/page');
  });

  it('formats sprinkle events with sprinkle label', () => {
    const event = {
      type: 'sprinkle',
      sprinkleName: 'welcome',
      body: { foo: 1 },
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out!.label).toBe('Sprinkle Event');
    expect(out!.content).toContain('[Sprinkle Event: welcome]');
  });
});
