import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_LICK_CHANNELS,
  formatLickEventForCone,
} from '../../src/scoops/lick-formatting.js';
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

  it('upgrade with a registered lickId surfaces the binary confirm/dismiss guidance', () => {
    const event = {
      type: 'upgrade',
      upgradeFromVersion: '0.1.0',
      upgradeToVersion: '0.2.0',
      timestamp: '2026-04-30T12:00:00Z',
      body: { releasedAt: null },
      lickId: 'lick-upgrade-1',
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out!.content).toContain('Lick ID: lick-upgrade-1');
    expect(out!.content).toContain('lick_confirm');
    expect(out!.content).toContain('Update workspace files');
    expect(out!.content).toContain('lick_dismiss');
    // Changelog stays a separate step, not a card action.
    expect(out!.content).toContain('separate step');
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

  it('prefixes a forwarded origin label when present', () => {
    const event = {
      type: 'navigate',
      navigateUrl: 'https://example.com',
      timestamp: '2026-05-29T00:00:00Z',
      body: { url: 'https://example.com', verb: 'upskill' },
      originFollowerId: 'b1',
      originLabel: 'extension follower',
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out).not.toBeNull();
    expect(out!.content).toContain('Forwarded from extension follower');
    expect(out!.content).toContain('[Navigate Event: https://example.com]');
  });

  it('omits the origin prefix when no originLabel is set', () => {
    const event = {
      type: 'navigate',
      navigateUrl: 'https://example.com',
      timestamp: '2026-05-29T00:00:00Z',
      body: {},
    } as unknown as LickEvent;
    const out = formatLickEventForCone(event);
    expect(out!.content).not.toContain('Forwarded from');
  });
});

describe('navigate lick actionable formatting', () => {
  it('appends Lick ID + lick_confirm guidance for an upskill navigate lick', () => {
    const out = formatLickEventForCone({
      type: 'navigate',
      navigateUrl: 'https://origin',
      lickId: 'lick-nav-1',
      timestamp: '2026-06-10T00:00:00.000Z',
      body: { url: 'https://origin', verb: 'upskill', target: 'https://github.com/o/r' },
    } as never);
    expect(out).not.toBeNull();
    expect(out!.label).toBe('Navigate Event');
    expect(out!.content).toContain('[Navigate Event: https://origin]');
    expect(out!.content).toContain('Lick ID: lick-nav-1');
    expect(out!.content).toContain('lick_confirm');
    expect(out!.content).toContain('lick_dismiss');
  });

  it('appends Lick ID + human-gate guidance for a handoff navigate lick', () => {
    const out = formatLickEventForCone({
      type: 'navigate',
      navigateUrl: 'https://origin',
      lickId: 'lick-nav-2',
      timestamp: '2026-06-10T00:00:00.000Z',
      body: {
        url: 'https://origin',
        verb: 'handoff',
        target: 'https://origin',
        instruction: 'do x',
      },
    } as never);
    expect(out).not.toBeNull();
    expect(out!.content).toContain('Lick ID: lick-nav-2');
    expect(out!.content).toContain('human-gated');
    expect(out!.content).toContain("data:{lickId:'lick-nav-2'}");
    // Handoff must NOT instruct self-approval via the agent tools.
    expect(out!.content).toContain('do NOT use `lick_confirm`');
  });

  it('falls back to the plain JSON block when no lickId is registered', () => {
    const out = formatLickEventForCone({
      type: 'navigate',
      navigateUrl: 'https://origin',
      timestamp: '2026-06-10T00:00:00.000Z',
      body: { url: 'https://origin', verb: 'upskill', target: 'https://github.com/o/r' },
    } as never);
    expect(out!.content).not.toContain('Lick ID:');
    expect(out!.content).not.toContain('lick_confirm');
  });
});

describe('cherry lick formatting', () => {
  it('formats a cherry host event for the cone', () => {
    const formatted = formatLickEventForCone({
      type: 'cherry',
      cherryName: 'checkout-complete',
      cherryRuntimeId: 'follower-abc',
      cherryOrigin: 'https://shop.example',
      timestamp: new Date().toISOString(),
      body: { orderId: 42 },
    } as never);
    expect(formatted).not.toBeNull();
    expect(formatted!.label).toBe('Cherry Event');
    expect(formatted!.content).toContain('checkout-complete');
    expect(formatted!.content).toContain('shop.example');
  });
});

it("formats a 'workflow' completion lick", () => {
  expect(EXTERNAL_LICK_CHANNELS.has('workflow')).toBe(true);
  const formatted = formatLickEventForCone({
    type: 'workflow',
    workflowRunId: 'abc123',
    workflowName: 'repo-audit',
    resultPath: '/shared/workflow-runs/abc123.json',
    preview: '{"confirmed":3}',
    timestamp: '2026-06-08T00:00:00.000Z',
    body: { runId: 'abc123' },
  });
  expect(formatted).not.toBeNull();
  expect(formatted!.content).toContain('repo-audit');
  expect(formatted!.content).toContain('/shared/workflow-runs/abc123.json');
  expect(formatted!.content).toContain('{"confirmed":3}');
});

describe("'sudo-request' lick formatting", () => {
  it('is a member of EXTERNAL_LICK_CHANNELS', () => {
    expect(EXTERNAL_LICK_CHANNELS.has('sudo-request')).toBe(true);
  });

  it('formats a sudo-request with id + kind + detail + lick_confirm hint', () => {
    const formatted = formatLickEventForCone({
      type: 'sudo-request',
      lickId: 'lick-req-1',
      sudoKind: 'write',
      sudoDetail: '/workspace/build/output.txt',
      sudoScoopName: 'tight-sandbox-scoop',
      sudoSuggestedPattern: '/workspace/build/**',
      timestamp: '2026-06-08T00:00:00.000Z',
      body: { requestId: 'lick-req-1' },
    } as never);
    expect(formatted).not.toBeNull();
    expect(formatted!.label).toBe('Scoop Access Request');
    expect(formatted!.content).toContain('[Scoop Access Request: tight-sandbox-scoop]');
    expect(formatted!.content).toContain('Lick ID: lick-req-1');
    expect(formatted!.content).toContain('Kind: write');
    expect(formatted!.content).toContain('Detail: /workspace/build/output.txt');
    expect(formatted!.content).toContain('Suggested pattern: /workspace/build/**');
    expect(formatted!.content).toContain('lick_confirm');
    expect(formatted!.content).toContain('lick_dismiss');
    expect(formatted!.content).toContain('lick_id="lick-req-1"');
  });

  it('omits the suggested-pattern line when no pattern is provided', () => {
    const formatted = formatLickEventForCone({
      type: 'sudo-request',
      lickId: 'lick-req-2',
      sudoKind: 'command',
      sudoDetail: 'rm -rf /tmp/x',
      sudoScoopName: 'scoop',
      timestamp: '2026-06-08T00:00:00.000Z',
      body: {},
    } as never);
    expect(formatted).not.toBeNull();
    expect(formatted!.content).not.toContain('Suggested pattern:');
  });
});
