import { describe, expect, it } from 'vitest';
import {
  type PairablePeer,
  resolveFollowerPairs,
} from '../../../src/scoops/tray-leader/follower-pairing.js';

/** The CLI half of `slicc … follow --computer bash -c`. */
function cli(bootstrapId: string, pairId?: string): PairablePeer {
  return { bootstrapId, exec: true, computer: false, pairId };
}

/** The headless Sliccstart the CLI spawned. */
function launcher(bootstrapId: string, pairId?: string): PairablePeer {
  return { bootstrapId, exec: false, computer: true, pairId };
}

describe('resolveFollowerPairs', () => {
  it('folds a CLI and the launcher sharing its token into one entry', () => {
    const pairing = resolveFollowerPairs([cli('cli-1', 'pair-a'), launcher('mac-1', 'pair-a')]);

    expect([...pairing.absorbedBy]).toEqual([['mac-1', 'cli-1']]);
    expect([...pairing.computerPartner]).toEqual([['cli-1', 'mac-1']]);
  });

  it('is order-independent — the launcher may say hello first', () => {
    const pairing = resolveFollowerPairs([launcher('mac-1', 'pair-a'), cli('cli-1', 'pair-a')]);

    expect(pairing.computerPartner.get('cli-1')).toBe('mac-1');
  });

  it('keeps unrelated followers and separate pairs apart', () => {
    const pairing = resolveFollowerPairs([
      cli('cli-1', 'pair-a'),
      launcher('mac-1', 'pair-a'),
      cli('cli-2', 'pair-b'),
      launcher('mac-2', 'pair-b'),
      { bootstrapId: 'browser', exec: false, computer: false },
    ]);

    expect(pairing.computerPartner.get('cli-1')).toBe('mac-1');
    expect(pairing.computerPartner.get('cli-2')).toBe('mac-2');
    expect(pairing.absorbedBy.has('browser')).toBe(false);
  });

  it('folds nothing without a token', () => {
    // Today's behaviour for a plain menu-bar Sliccstart beside a plain
    // `follow`: two peers that never claimed to be the same machine.
    const pairing = resolveFollowerPairs([cli('cli-1'), launcher('mac-1')]);

    expect(pairing.absorbedBy.size).toBe(0);
    expect(pairing.computerPartner.size).toBe(0);
  });

  it('ignores a blank or whitespace token rather than grouping on it', () => {
    const pairing = resolveFollowerPairs([cli('cli-1', '  '), launcher('mac-1', '')]);

    expect(pairing.absorbedBy.size).toBe(0);
  });

  it('leaves the launcher standing alone when no exec peer shares the token', () => {
    // `follow --computer` with no runner: the launcher IS the roster entry, so
    // hiding it would make the Mac unaddressable.
    const pairing = resolveFollowerPairs([
      { bootstrapId: 'cli-1', exec: false, computer: false, pairId: 'pair-a' },
      launcher('mac-1', 'pair-a'),
    ]);

    expect(pairing.absorbedBy.size).toBe(0);
  });

  it('folds nothing when two exec peers claim one token', () => {
    // Two CLIs cannot both be this machine; folding into either would give one
    // of them a screen that is not its own.
    const pairing = resolveFollowerPairs([
      cli('cli-1', 'pair-a'),
      cli('cli-2', 'pair-a'),
      launcher('mac-1', 'pair-a'),
    ]);

    expect(pairing.absorbedBy.size).toBe(0);
  });

  it('folds only the first launcher and leaves a leftover visible', () => {
    // A restart can leave a stale launcher on the token. Hiding it too would
    // make a live peer vanish from every roster with nothing to fold it into.
    const pairing = resolveFollowerPairs([
      cli('cli-1', 'pair-a'),
      launcher('mac-1', 'pair-a'),
      launcher('mac-stale', 'pair-a'),
    ]);

    expect(pairing.computerPartner.get('cli-1')).toBe('mac-1');
    expect(pairing.absorbedBy.has('mac-stale')).toBe(false);
  });

  it('never absorbs a peer that is already exec+computer on its own', () => {
    const both = { bootstrapId: 'both', exec: true, computer: true, pairId: 'pair-a' };
    const pairing = resolveFollowerPairs([both, cli('cli-1', 'pair-a')]);

    // Two exec peers → ambiguous → nothing folded, and certainly not the peer
    // that already answers `computer.native.*` itself.
    expect(pairing.absorbedBy.size).toBe(0);
  });

  it('pairs an exec+computer primary with a partner when it is the only exec peer', () => {
    const pairing = resolveFollowerPairs([
      { bootstrapId: 'both', exec: true, computer: true, pairId: 'pair-a' },
      launcher('mac-1', 'pair-a'),
    ]);

    expect(pairing.computerPartner.get('both')).toBe('mac-1');
  });

  it('folds nothing for a lone peer holding a token', () => {
    // The launcher died, or has not said hello yet.
    expect(resolveFollowerPairs([cli('cli-1', 'pair-a')]).absorbedBy.size).toBe(0);
  });

  it('handles an empty roster', () => {
    expect(resolveFollowerPairs([]).absorbedBy.size).toBe(0);
  });
});
