// Unit tests for the pure cup-auto-launch core. The actual detached spawn lives
// in the thin `cup-up.mjs` wrapper; all branching is here so it's testable
// without launching a real cup (mirrors the rest of _lib.mjs). `resolveBase` is
// injected and RE-READ each poll so a cup that binds a different port than the
// pre-launch guess (5710 busy → ephemeral fallback) is still found.
import { describe, expect, it, vi } from 'vitest';
import { ensureCupReady } from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';

const noSleep = () => Promise.resolve();
const at = (port) => `http://127.0.0.1:${port}`;

describe('ensureCupReady', () => {
  it('returns without launching when a cup is already live', async () => {
    const launch = vi.fn();
    const probe = vi.fn().mockResolvedValue(true);
    const res = await ensureCupReady({
      resolveBase: () => at(5710),
      probe,
      launch,
      sleep: noSleep,
    });
    expect(res).toEqual({ base: at(5710), launched: false });
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches once, then resolves when the cup comes up on the same port', async () => {
    const launch = vi.fn();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false) // initial liveness check
      .mockResolvedValueOnce(false) // first poll after launch
      .mockResolvedValueOnce(true); // second poll — up
    const res = await ensureCupReady({
      resolveBase: () => at(5710),
      probe,
      launch,
      sleep: noSleep,
      attempts: 5,
    });
    expect(res).toEqual({ base: at(5710), launched: true });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('re-resolves the port each poll — finds a cup that bound a DIFFERENT port', async () => {
    const launch = vi.fn();
    // Pre-launch probe hits 5710 (busy / non-cup → false); the launched cup binds
    // 5711 and rewrites cup.json, so resolveBase returns 5711 on the next poll.
    const resolveBase = vi.fn().mockReturnValueOnce(at(5710)).mockReturnValue(at(5711));
    const probe = vi.fn(async (b) => b === at(5711));
    const res = await ensureCupReady({ resolveBase, probe, launch, sleep: noSleep, attempts: 5 });
    expect(res).toEqual({ base: at(5711), launched: true });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('launches once, then throws after exhausting the probe budget', async () => {
    const launch = vi.fn();
    const probe = vi.fn().mockResolvedValue(false);
    await expect(
      ensureCupReady({ resolveBase: () => at(5710), probe, launch, sleep: noSleep, attempts: 3 })
    ).rejects.toThrow(/did not become ready/);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
