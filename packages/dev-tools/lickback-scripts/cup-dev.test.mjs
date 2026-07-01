// Unit tests for the cup bring-up helpers. The full orchestration (mode detect, wrangler +
// cup spawn) lives in the thin `cup-up.mjs` wrapper; the testable branching (readiness
// probes, poll, dev/prod mode) is here, injected with a fake fetch/sleep.
import { describe, expect, it, vi } from 'vitest';
import {
  cupLaunchMode,
  probeCupBridgeReady,
  probeHttpUp,
  waitUntil,
} from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';

describe('cupLaunchMode', () => {
  it('dev on a feature-branch clone (HEAD is not main)', () => {
    expect(cupLaunchMode('feat/external-brain-shell-bridge')).toBe('dev');
  });
  it('prod on main, detached HEAD, or outside a git clone', () => {
    expect(cupLaunchMode('main')).toBe('prod');
    expect(cupLaunchMode('HEAD')).toBe('prod');
    expect(cupLaunchMode(null)).toBe('prod');
    expect(cupLaunchMode('')).toBe('prod');
  });
});

describe('probeCupBridgeReady', () => {
  it('true only when GET /api/targets responds ok (bridge registered + browser connected)', async () => {
    const fetchOk = vi.fn().mockResolvedValue({ ok: true });
    expect(await probeCupBridgeReady('http://127.0.0.1:5710', fetchOk)).toBe(true);
    expect(fetchOk).toHaveBeenCalledWith('http://127.0.0.1:5710/api/targets', expect.anything());
  });

  it('false when /api/targets 500s (a cone-less prod webapp lacks the steering bridge)', async () => {
    const fetch500 = vi.fn().mockResolvedValue({ ok: false });
    expect(await probeCupBridgeReady('http://127.0.0.1:5710', fetch500)).toBe(false);
  });

  it('false when the request throws (connecting)', async () => {
    const fetchErr = vi.fn().mockRejectedValue(new Error('conn refused'));
    expect(await probeCupBridgeReady('http://127.0.0.1:5710', fetchErr)).toBe(false);
  });
});

describe('probeHttpUp', () => {
  it('true on any response — even 404 means something is listening (e.g. wrangler)', async () => {
    expect(
      await probeHttpUp('http://localhost:8787', vi.fn().mockResolvedValue({ status: 404 }))
    ).toBe(true);
  });
  it('false when the connection is refused', async () => {
    expect(
      await probeHttpUp(
        'http://localhost:8787',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      )
    ).toBe(false);
  });
});

describe('waitUntil', () => {
  const noSleep = () => Promise.resolve();
  it('resolves true once the probe passes', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect(await waitUntil(probe, { sleep: noSleep, attempts: 5 })).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });
  it('resolves false after exhausting the attempt budget', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    expect(await waitUntil(probe, { sleep: noSleep, attempts: 3 })).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
