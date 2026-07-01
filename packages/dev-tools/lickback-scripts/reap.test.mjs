// Unit tests for the bootstrap drain-reaper core. A new brain, before claiming a
// cup's lick-back channel, reaps any stale `lickback-drain` left over from a prior
// session (the orphan that pins the claim). The reaper is PORT-SCOPED so it never
// touches a parallel cup's live drain, and pid-reuse-safe via an injected
// `isReapable` predicate (alive AND actually a lickback-drain). All branching is
// the pure core here; the wrapper only wires fs/process to it.
import { describe, expect, it } from 'vitest';
import {
  drainPidfileName,
  drainsDir,
  parseDrainPidfileName,
  reapStaleDrains,
} from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';

describe('drain pidfile naming', () => {
  it('drainsDir nests under the lickback dir', () => {
    expect(drainsDir('/x/lickback')).toBe('/x/lickback/drains');
  });
  it('round-trips port + pid through the filename', () => {
    expect(drainPidfileName(5710, 6495)).toBe('5710-6495');
    expect(parseDrainPidfileName('5710-6495')).toEqual({ port: 5710, pid: 6495 });
  });
  it('rejects malformed names', () => {
    expect(parseDrainPidfileName('garbage')).toBeNull();
    expect(parseDrainPidfileName('5710-')).toBeNull();
    expect(parseDrainPidfileName('-6495')).toBeNull();
    expect(parseDrainPidfileName('5710-6495-extra')).toBeNull();
    expect(parseDrainPidfileName('0-6495')).toBeNull(); // port out of range
    expect(parseDrainPidfileName('5710-0')).toBeNull(); // pid must be > 0
    expect(parseDrainPidfileName('70000-9')).toBeNull(); // port out of range
  });
});

describe('reapStaleDrains (pure core)', () => {
  const run = (entries, { reapable = () => true } = {}) => {
    const killed = [];
    const removed = [];
    const res = reapStaleDrains({
      port: 5710,
      listEntries: () => entries,
      isReapable: (pid) => reapable(pid),
      kill: (pid) => killed.push(pid),
      remove: (name) => removed.push(name),
    });
    return { res, killed, removed };
  };

  it('kills + removes a live same-port drain', () => {
    const { res, killed, removed } = run(['5710-100']);
    expect(killed).toEqual([100]);
    expect(removed).toEqual(['5710-100']);
    expect(res).toEqual({ killed: [100], removed: ['5710-100'] });
  });

  it('removes a non-reapable same-port pidfile WITHOUT killing (dead drain, or pid reused by an unrelated process)', () => {
    const { killed, removed } = run(['5710-100'], { reapable: () => false });
    expect(killed).toEqual([]);
    expect(removed).toEqual(['5710-100']);
  });

  it("leaves OTHER cups' drains untouched (port-scoped)", () => {
    const { killed, removed } = run(['5720-200', '5710-100', '5730-300']);
    expect(killed).toEqual([100]);
    expect(removed).toEqual(['5710-100']);
  });

  it('skips unparseable entries', () => {
    const { killed, removed } = run(['garbage', '5710-100', 'README.md']);
    expect(killed).toEqual([100]);
    expect(removed).toEqual(['5710-100']);
  });

  it('reaps several same-port drains in one pass', () => {
    const { killed, removed } = run(['5710-100', '5710-101', '5720-200']);
    expect(killed).toEqual([100, 101]);
    expect(removed).toEqual(['5710-100', '5710-101']);
  });

  it('is a no-op on an empty drains dir', () => {
    expect(run([])).toEqual({ res: { killed: [], removed: [] }, killed: [], removed: [] });
  });
});
