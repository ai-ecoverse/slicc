import { describe, expect, it } from 'vitest';
import { confirmFollowerStop } from '../../src/scoops/follower-abort.js';

const tree = [
  { jid: 'cone', parentJid: null },
  { jid: 'scoop', parentJid: 'cone' },
  { jid: 'other', parentJid: null },
];

describe('confirmFollowerStop', () => {
  it('stops the named tree deepest-first and acks once it stays idle', async () => {
    let now = 0;
    const processing = new Set(['cone', 'scoop', 'other']);
    const stopped: string[] = [];
    const outcome = await confirmFollowerStop({
      target: 'cone',
      units: () => tree,
      stop: (jid) => {
        stopped.push(jid);
        processing.delete(jid);
      },
      isProcessing: (jid) => processing.has(jid),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      boundMs: 1_000,
      pollMs: 50,
    });
    expect(stopped).toEqual(['scoop', 'cone']);
    expect(outcome).toEqual({ confirmed: true, scoopJid: 'cone', stopped: ['scoop', 'cone'] });
    expect(processing.has('other')).toBe(true);
  });

  it('does not confirm when a scoop in the tree keeps processing', async () => {
    let now = 0;
    const outcome = await confirmFollowerStop({
      target: 'cone',
      units: () => tree,
      stop: () => {},
      isProcessing: (jid) => jid === 'scoop',
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      boundMs: 100,
      pollMs: 50,
    });
    expect(outcome.confirmed).toBe(false);
    expect(outcome.stopped).toEqual(['scoop', 'cone']);
  });

  it('stops a child that registers after the first stop pass', async () => {
    let now = 0;
    const units: Array<{ jid: string; parentJid: string | null }> = [
      { jid: 'cone', parentJid: null },
    ];
    const processing = new Set(['cone']);
    const stopped: string[] = [];
    const outcome = await confirmFollowerStop({
      target: 'cone',
      units: () => units,
      stop: (jid) => {
        stopped.push(jid);
        processing.delete(jid);
      },
      isProcessing: (jid) => processing.has(jid),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        if (now === ms) {
          units.push({ jid: 'late-scoop', parentJid: 'cone' });
          processing.add('late-scoop');
        }
      },
      boundMs: 1_000,
      pollMs: 50,
    });
    expect(stopped).toEqual(['cone', 'late-scoop']);
    expect(outcome).toEqual({
      confirmed: true,
      scoopJid: 'cone',
      stopped: ['late-scoop', 'cone'],
    });
  });

  it('does not confirm when the stop itself fails', async () => {
    const outcome = await confirmFollowerStop({
      target: 'cone',
      units: () => tree,
      stop: () => {
        throw new Error('kernel gone');
      },
      isProcessing: () => false,
      now: () => 0,
      sleep: async () => {},
      boundMs: 1_000,
      pollMs: 50,
    });
    expect(outcome.confirmed).toBe(false);
  });
});
