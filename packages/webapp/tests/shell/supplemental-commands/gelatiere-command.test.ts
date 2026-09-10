import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GELATIERE_INSTRUCTIONS_PATH,
  GELATIERE_STATE_PATH,
  GELATIERE_SUGGESTIONS_PATH,
  type GelatiereSuggestion,
} from '../../../src/base/gelatiere-store.js';
import type { VirtualFS } from '../../../src/fs/index.js';
import { createGelatiereCommand } from '../../../src/shell/supplemental-commands/gelatiere-command.js';

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs = {
    files,
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    },
    writeFile: async (path: string, body: string) => {
      files.set(path, body);
    },
    mkdir: async () => {},
  };
  return fs as unknown as VirtualFS & { files: Map<string, string> };
}

function suggestion(id: string, extra: Partial<GelatiereSuggestion> = {}): GelatiereSuggestion {
  return { id, kind: 'skill', title: `Title ${id}`, body: 'b', createdAt: 'now', ...extra };
}

type Globals = typeof globalThis & { __slicc_gelatiere?: unknown };

/** What `createKernelHost` publishes through `publishGelatiereSeam`. */
function fakeSeam(roots: Array<{ folder: string; name: string; jid: string }>) {
  let unit: { folder: string; jid: string } | undefined;
  return {
    ensureUnit: vi.fn(async () => {
      const created = !unit;
      unit ??= { folder: 'gelatiere', jid: 'cone_gelatiere' };
      return { ...unit, created };
    }),
    unregisterOwned: vi.fn(async () => {
      const gone = unit ? [unit.jid] : [];
      unit = undefined;
      return gone;
    }),
    unit: () => (unit ? { ...unit, name: 'gelatiere' } : undefined),
    roots: () => roots,
    ensureNightly: vi.fn(async (cron: string) => ({ id: 'ct-1', cron, created: true })),
    nightly: () => ({ id: 'ct-1', cron: '0 3 * * *' }),
    lick: vi.fn(),
  };
}

describe('gelatiere command', () => {
  let seam: ReturnType<typeof fakeSeam>;

  beforeEach(() => {
    seam = fakeSeam([
      { folder: 'cone', name: 'sliccy', jid: 'cone_1' },
      { folder: 'cone-research', name: 'Research', jid: 'cone_2' },
    ]);
    (globalThis as Globals).__slicc_gelatiere = seam;
  });

  afterEach(() => {
    delete (globalThis as Globals).__slicc_gelatiere;
  });

  const run = (fs: VirtualFS, args: string[], env: Record<string, string> = {}) =>
    (
      createGelatiereCommand({ fs }) as unknown as {
        execute(
          a: string[],
          ctx: unknown
        ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
      }
    ).execute(args, { cwd: '/', env, fs });

  it('prints help for no args, --help, and deliver --help without acting', async () => {
    const fs = memoryFs();
    for (const args of [[], ['--help'], ['deliver', '--help'], ['deliver', '--scoop', 'x', '-h']]) {
      const result = await run(fs, args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: gelatiere');
    }
    expect(seam.lick).not.toHaveBeenCalled();
    const unknown = await run(fs, ['bogus']);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('unknown command: bogus');
  });

  it('init creates the unit and the nightly crontask from the instruction file, idempotently', async () => {
    const fs = memoryFs({ [GELATIERE_INSTRUCTIONS_PATH]: '---\nnightly: "15 4 * * *"\n---\nbody' });
    const first = await run(fs, ['init']);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('Created the gelatiere (cone_gelatiere');
    expect(first.stdout).toContain('Registered nightly pass: cron "15 4 * * *"');
    expect(seam.ensureNightly).toHaveBeenCalledWith('15 4 * * *');
    seam.ensureNightly.mockResolvedValueOnce({ id: 'ct-1', cron: '15 4 * * *', created: false });
    const second = await run(fs, ['init']);
    expect(second.stdout).toContain('Found the gelatiere');
    expect(second.stdout).toContain('Found nightly pass');
  });

  it("init --reset drops the owner's units first, and a taken folder is reported cleanly", async () => {
    await run(memoryFs(), ['init']);
    const reset = await run(memoryFs(), ['init', '--reset']);
    expect(reset.stdout).toContain('Dropped 1 gelatiere unit(s): cone_gelatiere');
    expect(reset.stdout).toContain('Created the gelatiere');
    seam.ensureUnit.mockRejectedValueOnce(new Error('folder "gelatiere" is held by cone cone_x'));
    const taken = await run(memoryFs(), ['init']);
    expect(taken.exitCode).toBe(1);
    expect(taken.stderr).toContain('held by cone cone_x');
  });

  it('run ensures the unit and licks it with a manual run request naming the caller', async () => {
    const result = await run(memoryFs(), ['run'], { SLICC_LICK_TARGET: 'cone-research' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Asked the gelatiere');
    expect(seam.lick).toHaveBeenCalledWith('gelatiere', {
      action: 'run',
      data: { reason: 'manual', requestedBy: 'cone-research' },
    });
  });

  it('suggest folds a candidates file into the store and stamps the pass', async () => {
    const fs = memoryFs({
      '/tmp/c.json': JSON.stringify({ suggestions: [suggestion('skill-a'), { kind: 'nope' }] }),
    });
    const result = await run(fs, ['suggest', '/tmp/c.json']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Pass recorded: 1 new, 1 open');
    expect(result.stdout).toContain('+ skill-a');
    expect(JSON.parse(fs.files.get(GELATIERE_STATE_PATH) ?? '{}').passes).toBe(1);
    const again = await run(fs, ['suggest', '/tmp/c.json']);
    expect(again.stdout).toContain('Nothing new');
    expect((await run(fs, ['suggest'])).exitCode).toBe(1);
    const missing = await run(fs, ['suggest', '/tmp/missing.json']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('cannot read /tmp/missing.json');
  });

  it('deliver licks every other root with what is new, then stamps the delivery', async () => {
    const fs = memoryFs({
      [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([
        suggestion('new', { createdAt: '2026-09-09T10:00:00.000Z' }),
        suggestion('old', { createdAt: '2026-09-01T00:00:00.000Z' }),
      ]),
      [GELATIERE_STATE_PATH]: JSON.stringify({
        passes: 1,
        lastDeliveredAt: '2026-09-05T00:00:00.000Z',
      }),
    });
    const result = await run(fs, ['deliver']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Delivered 1 new (2 open) to 2 cone(s): cone, cone-research');
    expect(seam.lick).toHaveBeenCalledTimes(2);
    expect(seam.lick).toHaveBeenNthCalledWith(
      1,
      'cone',
      expect.objectContaining({
        action: 'gelatiere-suggestions',
        data: expect.objectContaining({
          added: 1,
          open: 2,
          skill: expect.stringContaining('SKILL.md'),
        }),
      })
    );
    expect(seam.lick).toHaveBeenNthCalledWith(2, 'cone-research', expect.anything());
    expect(JSON.parse(fs.files.get(GELATIERE_STATE_PATH) ?? '{}').lastDeliveredAt).toBeTruthy();

    // Nothing new since that delivery → no lick; --force resends to one target.
    seam.lick.mockClear();
    const quiet = await run(fs, ['deliver']);
    expect(quiet.stdout).toContain('Nothing new since the last delivery');
    expect(seam.lick).not.toHaveBeenCalled();
    const forced = await run(fs, ['deliver', '--force', '--scoop', 'Research']);
    expect(forced.stdout).toContain('to 1 cone(s): Research');
    expect(seam.lick).toHaveBeenCalledWith('Research', expect.anything());
  });

  it('deliver fails cleanly with nothing to deliver to', async () => {
    seam = fakeSeam([]);
    (globalThis as Globals).__slicc_gelatiere = seam;
    const fs = memoryFs({ [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([suggestion('a')]) });
    const result = await run(fs, ['deliver']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no cone is running');
  });

  it('list shows open suggestions, --all adds taken and dismissed, --json dumps the store', async () => {
    const fs = memoryFs({
      [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([
        suggestion('skill-a', { install: 'upskill a' }),
        suggestion('tip-b', { kind: 'tip', dismissedAt: 'x' }),
        suggestion('use-c', { kind: 'use-case', takenAt: 'x' }),
      ]),
    });
    const open = await run(fs, ['list']);
    expect(open.stdout).toContain('skill-a  [skill]');
    expect(open.stdout).toContain('install: upskill a');
    expect(open.stdout).not.toContain('tip-b');
    expect(open.stdout).not.toContain('use-c');
    const all = await run(fs, ['list', '--all']);
    expect(all.stdout).toContain('tip-b  [tip] (dismissed)');
    expect(all.stdout).toContain('use-c  [use-case] (taken)');
    const json = await run(fs, ['list', '--json']);
    expect(JSON.parse(json.stdout)).toHaveLength(1);
    expect((await run(memoryFs(), ['list'])).stdout).toContain('No suggestions yet');
  });

  it('dismiss stamps an open entry and refuses unknown ids', async () => {
    const fs = memoryFs({ [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([suggestion('skill-a')]) });
    expect((await run(fs, ['dismiss', 'skill-a'])).stdout).toContain('Dismissed skill-a');
    expect(
      JSON.parse(fs.files.get(GELATIERE_SUGGESTIONS_PATH) ?? '[]')[0].dismissedAt
    ).toBeTruthy();
    const again = await run(fs, ['dismiss', 'skill-a']);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('no open suggestion');
    expect((await run(fs, ['dismiss'])).exitCode).toBe(1);
  });

  it('status reports the unit, schedule, ledger, and counts', async () => {
    await run(memoryFs(), ['init']);
    const fs = memoryFs({
      [GELATIERE_STATE_PATH]: JSON.stringify({
        passes: 2,
        lastPassAt: '2026-09-09T00:00:00.000Z',
        lastDeliveredAt: '2026-09-09T00:05:00.000Z',
      }),
      [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([
        suggestion('a'),
        suggestion('b', { dismissedAt: 'x' }),
        suggestion('c', { takenAt: 'x' }),
      ]),
    });
    const result = await run(fs, ['status']);
    expect(result.stdout).toContain('Unit:           cone_gelatiere (folder gelatiere)');
    expect(result.stdout).toContain('Nightly:        registered, cron "0 3 * * *" (ct-1)');
    expect(result.stdout).toContain('Interval:       24h');
    expect(result.stdout).toContain('Passes:         2');
    expect(result.stdout).toContain('Last delivery:  2026-09-09T00:05:00.000Z');
    expect(result.stdout).toContain('Suggestions:    1 open, 1 taken, 3 total');
  });

  it('every seam-backed verb fails cleanly before the host publishes the seam', async () => {
    delete (globalThis as Globals).__slicc_gelatiere;
    for (const args of [['init'], ['run'], ['deliver', '--force']]) {
      const result = await run(memoryFs({ [GELATIERE_SUGGESTIONS_PATH]: '[]' }), args);
      expect(result.exitCode, args.join(' ')).toBe(1);
      expect(result.stderr).toContain('kernel host has not booted');
    }
    // The store-only verbs still answer.
    expect((await run(memoryFs(), ['status'])).stdout).toContain('not created');
  });
});
