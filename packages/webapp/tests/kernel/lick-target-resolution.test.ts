import { describe, expect, it, vi } from 'vitest';
import { matchLickTargetAlias } from '../../src/base/lick-target-match.js';
import { defaultLickEventHandler } from '../../src/kernel/host.js';

/**
 * #2311 — addressing a lick to a cone by name. The resolver runs THREE ORDERED
 * PASSES (exact folder → `<alias>-scoop` folder → name) so the answer never
 * depends on the order units happen to sit in the registry.
 */

const primary = {
  jid: 'cone-jid',
  name: 'Cone',
  folder: 'cone',
  isCone: true,
  parentJid: null,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: '2026-01-01T00:00:00.000Z',
} as const;

/** An extra cone NAMED `reviewer` — the ambiguous case. */
const extraCone = {
  ...primary,
  jid: 'cone-reviewer-jid',
  name: 'reviewer',
  folder: 'cone-reviewer',
  addedAt: '2026-02-01T00:00:00.000Z',
} as const;

/** A scoop whose FOLDER is `reviewer-scoop` — the other reading of `reviewer`. */
const reviewerScoop = {
  jid: 'scoop-jid',
  name: 'code-reviewer',
  folder: 'reviewer-scoop',
  isCone: false,
  parentJid: 'cone-jid',
  type: 'scoop',
  requiresTrigger: true,
  assistantLabel: 'reviewer-scoop',
  addedAt: '2026-03-01T00:00:00.000Z',
} as const;

function cronLick(targetScoop?: string) {
  return {
    type: 'cron' as const,
    ...(targetScoop ? { targetScoop } : {}),
    cronId: 'ct-1',
    cronName: 'digest',
    timestamp: 't',
    body: {},
  };
}

function routingCtx(scoops: readonly unknown[], handleMessage: ReturnType<typeof vi.fn>) {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    ctx: {
      orchestrator: { getScoops: () => scoops, handleMessage } as never,
      lickManager: {} as never,
      log,
    },
    log,
  };
}

describe('matchLickTargetAlias', () => {
  const roster = [extraCone, reviewerScoop];

  it('prefers an exact folder over every other form', () => {
    expect(matchLickTargetAlias(roster, 'cone-reviewer')?.jid).toBe('cone-reviewer-jid');
    expect(matchLickTargetAlias(roster, 'reviewer-scoop')?.jid).toBe('scoop-jid');
  });

  it('prefers the `<alias>-scoop` folder over a same-string name', () => {
    // `reviewer` is BOTH the extra cone's name and the scoop's bare alias.
    // Pass 2 (folder `reviewer-scoop`) runs before pass 3 (name), so the scoop wins.
    expect(matchLickTargetAlias(roster, 'reviewer')?.jid).toBe('scoop-jid');
  });

  it('gives the same answer for either registry order', () => {
    for (const target of ['reviewer', 'cone-reviewer', 'reviewer-scoop', 'code-reviewer']) {
      expect(matchLickTargetAlias([extraCone, reviewerScoop], target)?.jid).toBe(
        matchLickTargetAlias([reviewerScoop, extraCone], target)?.jid
      );
    }
  });

  it('falls through to the name when no folder matches', () => {
    expect(matchLickTargetAlias(roster, 'code-reviewer')?.jid).toBe('scoop-jid');
  });

  it('returns undefined for an unknown target', () => {
    expect(matchLickTargetAlias(roster, 'ghost')).toBeUndefined();
  });
});

describe('routeFormattedLickToCone target resolution', () => {
  it('routes an untargeted lick to the oldest root, not the newest', () => {
    const handleMessage = vi.fn(async () => undefined);
    // Newest first in the registry — `rootsOf` sorts by addedAt regardless.
    const { ctx } = routingCtx([extraCone, primary, reviewerScoop], handleMessage);
    defaultLickEventHandler(cronLick(), ctx);

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'cone-jid', channel: 'cron' })
    );
  });

  it('routes a lick addressed to a cone by name back to that cone', () => {
    const handleMessage = vi.fn(async () => undefined);
    // `Cone`/`cone` is the primary; address the extra cone by its display name.
    const { ctx } = routingCtx([primary, { ...extraCone, name: 'Research' }], handleMessage);
    defaultLickEventHandler(cronLick('Research'), ctx);

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'cone-reviewer-jid' })
    );
  });

  it('routes a lick addressed to a cone by folder back to that cone', () => {
    const handleMessage = vi.fn(async () => undefined);
    const { ctx } = routingCtx([primary, extraCone], handleMessage);
    defaultLickEventHandler(cronLick('cone-reviewer'), ctx);

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'cone-reviewer-jid' })
    );
  });

  it('resolves an ambiguous target the same way in either registry order', () => {
    const jids: (string | undefined)[] = [];
    for (const roster of [
      [primary, extraCone, reviewerScoop],
      [primary, reviewerScoop, extraCone],
    ]) {
      const handleMessage = vi.fn(async () => undefined);
      const { ctx } = routingCtx(roster, handleMessage);
      defaultLickEventHandler(cronLick('reviewer'), ctx);
      const calls = handleMessage.mock.calls as unknown as [{ chatJid: string }][];
      jids.push(calls[0]?.[0]?.chatJid);
    }
    expect(jids[0]).toBe(jids[1]);
    expect(jids[0]).toBe('scoop-jid');
  });

  it('warns and drops a targeted lick whose cone is gone — never redirects it', () => {
    const handleMessage = vi.fn(async () => undefined);
    const { ctx, log } = routingCtx([primary], handleMessage);
    defaultLickEventHandler(cronLick('cone-research'), ctx);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('Lick target scoop not found', 'cone-research');
  });

  it('still drops a discovery lick for a unit that cannot browse', () => {
    const handleMessage = vi.fn(async () => undefined);
    // Resolved through the new three-pass path, then rejected by the guard —
    // the drop happens BEFORE a lick id is minted, so no dangling registry entry.
    const walled = { ...reviewerScoop, config: { allowedCommands: ['ls'] } };
    const { ctx } = routingCtx([primary, walled], handleMessage);
    defaultLickEventHandler(
      {
        type: 'discovery' as const,
        targetScoop: 'reviewer-scoop',
        discoveryUrl: 'https://example.com/llms.txt',
        discoveryOrigin: 'https://example.com',
        discoveryKind: 'llms-txt',
        timestamp: 't',
        body: {},
      } as never,
      ctx
    );

    expect(handleMessage).not.toHaveBeenCalled();
  });
});
