import { describe, expect, it } from 'vitest';
import {
  BLIND_READ_RULE,
  BlindReadLog,
  findBlindNegativeClaim,
  formatBlindReadNote,
} from '../../src/base/blind-reads.js';

const ROOTS = ['/sessions/', '/shared/', '/workspace/'];

describe('BlindReadLog', () => {
  it('reports each blind read once, but remembers every outside path for the run', () => {
    const log = new BlindReadLog(ROOTS);
    expect(log.takeNote()).toBeUndefined();

    log.record('/etc/llmstxtignore', 'outside');
    log.record('/etc/llmstxtignore/', 'outside');
    log.record('/', 'filtered');
    const first = log.takeNote();
    expect(first).toContain('[not visible from this pass] /etc/llmstxtignore');
    expect(first).toContain('outside visiblePaths (/sessions/, /shared/, /workspace/)');
    expect(first).toContain('[filtered listing] /');
    expect(first).toContain(BLIND_READ_RULE);

    expect(log.takeNote()).toBeUndefined();
    log.record('/etc/MEMORY.md', 'outside');
    expect(log.takeNote()).toContain('/etc/MEMORY.md');
    expect(log.takeNote()).toBeUndefined();

    expect(log.outsidePaths()).toEqual(['/etc/llmstxtignore', '/etc/MEMORY.md']);
  });

  it('formats the note for whichever kinds occurred', () => {
    expect(formatBlindReadNote(ROOTS, ['/etc/x'], [])).not.toContain('[filtered listing]');
    expect(formatBlindReadNote(ROOTS, [], ['/cones'])).not.toContain('[not visible');
    expect(formatBlindReadNote([], ['/etc/x'], [])).toContain('(none)');
  });
});

describe('findBlindNegativeClaim', () => {
  const blind = ['/etc/llmstxtignore', '/etc/MEMORY.md'];

  it("catches the dreamers' refutations", () => {
    const notTrue =
      '- not: www.printful.com is in the ignore list — why: /etc/llmstxtignore no longer exists on 6.169.0 — instead: nothing (2026-09-24)';
    expect(findBlindNegativeClaim('', notTrue, blind)).toEqual({
      line: notTrue,
      path: '/etc/llmstxtignore',
    });
    const prose =
      'process: the contracts live in /shared/ (MEMORY.md, DREAMING.md), not `/etc/MEMORY.md` (2026-09-24)';
    expect(findBlindNegativeClaim('', prose, blind)).toEqual({
      line: prose,
      path: '/etc/MEMORY.md',
    });
  });

  it('flags the obvious absence markers on a line naming a blind path', () => {
    for (const line of [
      'process: /etc/llmstxtignore is missing on this install',
      'process: /etc/MEMORY.md does not exist (2026-09-24)',
      'pitfall: cat /etc/MEMORY.md → ENOENT',
      'process: /etc/llmstxtignore was removed in 6.169.0',
      'process: /etc/llmstxtignore not found',
    ]) {
      expect(findBlindNegativeClaim('', line, blind), line).not.toBeNull();
    }
  });

  it('lets a neutral or positive mention of a blind path through', () => {
    for (const line of [
      'process: www.printful.com is in /etc/llmstxtignore (verified from the cone 2026-09-18)',
      'process: memory instructions live in /etc/MEMORY.md, 24 allowed commands',
      "process: /etc/MEMORY.md is outside this pass's visiblePaths — unverifiable here",
    ]) {
      expect(findBlindNegativeClaim('', line, blind), line).toBeNull();
    }
  });

  it('ignores lines carried over unchanged, absence markers and all', () => {
    const carried = '- not: /etc/llmstxtignore exists — why: cone verified (2026-09-18)';
    expect(
      findBlindNegativeClaim(`# Memory\n${carried}\n`, `# Memory\n${carried}\n- new\n`, blind)
    ).toBeNull();

    expect(findBlindNegativeClaim('# Memory\n', `# Memory\n${carried}\n`, blind)).not.toBeNull();
  });

  it('ignores absence claims about paths the pass never probed, and needs a ledger at all', () => {
    const line = 'pitfall: /workspace/repo/dist is missing after a clean checkout';
    expect(findBlindNegativeClaim('', line, blind)).toBeNull();
    expect(findBlindNegativeClaim('', 'process: /etc/MEMORY.md is missing', [])).toBeNull();

    expect(findBlindNegativeClaim('', line, ['/'])).toBeNull();
  });

  it('matches a probed directory against a claim about a file under it', () => {
    const line = 'process: /etc/llmstxtignore is absent';
    expect(findBlindNegativeClaim('', line, ['/etc/'])).toEqual({ line, path: '/etc' });
  });
});
