/**
 * Edge cases of the profile export pieces: the generic stored-ZIP writer,
 * the profile redactor, the deps registry, folder sanitising, flat
 * sprinkles, name collisions and references to fully skipped directories.
 */
import { TranscriptExportError, validateSliccProfileManifestV1 } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { planProfileExport } from '../../src/transcript/profile-export.js';
import {
  getProfileExportDeps,
  getProfileExportRunner,
  registerProfileExportDeps,
  registerProfileExportRunner,
} from '../../src/transcript/profile-export-provider.js';
import { literalSecretsRedactor, redactProfileTexts } from '../../src/transcript/profile-redact.js';
import { createZipStream } from '../../src/transcript/zip-stream.js';
import { seedProfile, UNITS } from './profile-export-seed.js';

async function bin(
  fs: { readFile: (p: string, o: { encoding: 'binary' }) => Promise<unknown> },
  path: string
): Promise<Uint8Array> {
  return (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
}

async function drain(chunks: AsyncIterable<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const c of chunks) n += c.byteLength;
  return n;
}

describe('createZipStream', () => {
  it('rejects unsafe and duplicate names up front', () => {
    expect(() => createZipStream([{ path: '../x', load: () => new Uint8Array() }])).toThrow(
      TranscriptExportError
    );
    expect(() =>
      createZipStream([
        { path: 'a', load: () => new Uint8Array() },
        { path: 'a', load: () => new Uint8Array() },
      ])
    ).toThrow(TranscriptExportError);
  });

  it('rejects a loader failure on the receipt and on the stream', async () => {
    const stream = createZipStream([
      {
        path: 'a',
        load: () => {
          throw new Error('gone');
        },
      },
    ]);
    await expect(drain(stream.chunks)).rejects.toThrow('gone');
    await expect(stream.completion).rejects.toThrow('gone');
  });

  it('aborts between entries', async () => {
    const controller = new AbortController();
    const stream = createZipStream(
      [
        {
          path: 'a',
          load: () => {
            controller.abort();
            return new Uint8Array([1]);
          },
        },
      ],
      controller.signal
    );
    await expect(drain(stream.chunks)).rejects.toMatchObject({ code: 'transfer-aborted' });
  });
});

describe('profile redaction', () => {
  it('replaces long page secrets before the base redactor and ignores short ones', async () => {
    const seen: string[][] = [];
    const redactor = literalSecretsRedactor(
      {
        redact: async (texts) => {
          seen.push([...texts]);
          return texts;
        },
      },
      ['short', 'a-long-secret-1', 'a-long-secret-1-and-more']
    );
    const [out] = await redactor.redact(['x a-long-secret-1-and-more y a-long-secret-1 short']);
    expect(out).toBe(
      'x ⟦REDACTED:provider-credential:ps1⟧ y ⟦REDACTED:provider-credential:ps2⟧ short'
    );
    expect(seen[0]![0]).toBe(out);
  });

  it('counts known-secret and pattern markers, batching big inputs', async () => {
    const counts: { [k: string]: number } = {};
    const calls: number[] = [];
    const big = 'x'.repeat(700 * 1024);
    const out = await redactProfileTexts(
      [big, `${big} ghp_abcdefghijklmnopqrstuvwxyz0123456789`, 'already ⟦REDACTED:secret:A⟧'],
      {
        redact: async (texts) => {
          calls.push(texts.length);
          return texts;
        },
      },
      counts
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(out[1]).toContain('⟦REDACTED:api-key:');
    expect(counts['api-key']).toBe(1);
    expect(counts['secret']).toBeUndefined();
  });

  it('fails closed on a broken redactor', async () => {
    await expect(redactProfileTexts(['a'], { redact: async () => [] }, {})).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
    await expect(
      redactProfileTexts(
        ['a'],
        {
          redact: async () => {
            throw new Error('x');
          },
        },
        {}
      )
    ).rejects.toMatchObject({ code: 'redaction-unavailable' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      redactProfileTexts(['a'], { redact: async (t) => t }, {}, controller.signal)
    ).rejects.toMatchObject({ code: 'transfer-aborted' });
  });
});

describe('profile export registry', () => {
  it('registers, reads and tears down only its own entry', async () => {
    expect(() => getProfileExportDeps()).toThrow(/leader tab/);
    const { deps } = await seedProfile();
    const factory = () => deps;
    const teardown = registerProfileExportDeps(factory);
    const other = registerProfileExportDeps(() => deps);
    teardown();
    expect(getProfileExportDeps()).toBe(deps);
    other();
    expect(() => getProfileExportDeps()).toThrow();

    const run = async () => ({ report: '', archives: [] });
    const off = registerProfileExportRunner(run);
    expect(getProfileExportRunner()).toBe(run);
    const offOther = registerProfileExportRunner(async () => ({ report: 'b', archives: [] }));
    off();
    expect(getProfileExportRunner()).not.toBeNull();
    offOther();
    expect(getProfileExportRunner()).toBeNull();
  });
});

describe('planProfileExport — edge cases', () => {
  it('sanitises folders that break the shared rule and keeps them unique', async () => {
    const units = [
      ...UNITS,
      { jid: 'cone_3', name: 'Weird', folder: 'Weird Folder!', parentJid: null },
      { jid: 'cone_4', name: 'Dup', folder: 'weird-folder', parentJid: null },
      { jid: 'cone_5', name: 'Empty', folder: '___', parentJid: null },
    ];
    const { deps } = await seedProfile({ listUnits: () => units });
    const plan = await planProfileExport(deps);
    const folders = plan.archives[0]!.manifest.cones.map((c) => c.folder);
    expect(folders).toEqual(['cone', 'side-project', 'weird-folder-2', 'weird-folder', 'unit']);
    expect(validateSliccProfileManifestV1(plan.archives[0]!.manifest)).toEqual({ ok: true });
  });

  it('exports flat sprinkles, de-duplicates names, and drops fully skipped dirs', async () => {
    const { fs, deps } = await seedProfile();
    await fs.mkdir('/workspace/sprinkles/dash', { recursive: true });
    await fs.writeFile('/workspace/sprinkles/dash/dash.shtml', '<div>two</div>');
    await fs.writeFile('/workspace/sprinkles/solo.shtml', '<div>solo</div>');
    await fs.writeFile('/workspace/sprinkles/readme.txt', 'not a sprinkle');
    await fs.mkdir('/workspace/skills/empty-skill', { recursive: true });
    await fs.mkdir('/scoops/research-scoop/workspace/node_modules/x', { recursive: true });
    await fs.writeFile('/scoops/research-scoop/workspace/node_modules/x/a.js', '1');
    await fs.rm('/scoops/research-scoop/workspace/findings.md');
    const plan = await planProfileExport(deps);
    const m = plan.archives[0]!.manifest;
    expect(m.sprinkles).toEqual([
      { name: 'dash', path: 'sprinkles/dash/' },
      { name: 'dash-2', path: 'sprinkles/dash-2/' },
      { name: 'solo', path: 'sprinkles/solo/' },
    ]);
    expect(m.skipped).toContainEqual({ path: '/workspace/skills/empty-skill', reason: 'bundled' });
    expect(m.cones[0]!.scoops[0]!.files).toBeNull();
    expect(validateSliccProfileManifestV1(m)).toEqual({ ok: true });
  });

  it('skips bundled memory, unchanged bundled files, and unreadable files', async () => {
    const { fs, deps } = await seedProfile();
    const bundled = new Map<string, Uint8Array>([
      ['/shared/CLAUDE.md', await bin(fs, '/shared/CLAUDE.md')],
      ['/workspace/CLAUDE.md', await bin(fs, '/workspace/CLAUDE.md')],
      ['/workspace/notes.md', await bin(fs, '/workspace/notes.md')],
    ]);
    const readFile = fs.readFile.bind(fs);
    const plan = await planProfileExport({
      ...deps,
      bundledFile: async (p) => bundled.get(p) ?? null,
      vfs: {
        readDir: fs.readDir.bind(fs),
        stat: fs.stat.bind(fs),
        readFile: (async (path: string, opts?: { encoding?: 'utf-8' | 'binary' }) => {
          if (path.endsWith('app.ts')) throw new Error('EIO');
          return readFile(path, opts);
        }) as typeof deps.vfs.readFile,
      },
    });
    const m = plan.archives[0]!.manifest;
    expect(m.cones[0]!.memory).toBeNull();
    expect(m.files.some((f) => f.path === 'memory/global.md')).toBe(false);
    expect(m.skipped).toEqual(
      expect.arrayContaining([
        { path: '/shared/CLAUDE.md', reason: 'bundled' },
        { path: '/workspace/CLAUDE.md', reason: 'bundled' },
        { path: '/workspace/notes.md', reason: 'bundled' },
        { path: '/cones/side-project/workspace/app.ts', reason: 'unreadable' },
      ])
    );
  });

  it('exports an empty profile: no cones, no licks, no gitconfig, no secrets', async () => {
    const { deps } = await seedProfile({
      listUnits: () => [],
      accounts: () => [],
      licks: async () => ({ crontasks: [], tasks: [], webhooks: [] }),
      mcpServers: async () => null,
      mounts: async () => [],
      storedSecretKinds: async () => [],
      githubToken: async () => null,
      gitconfig: async () => null,
    });
    const plan = await planProfileExport(deps);
    const m = plan.archives[0]!.manifest;
    expect(m).toMatchObject({
      cones: [],
      licks: null,
      gitconfig: null,
      providers: [],
      secrets: [],
    });
    expect(validateSliccProfileManifestV1(m)).toEqual({ ok: true });
  });

  it('gives an unsafe frozen id a hashed file name and walks mounted roots not at all', async () => {
    const { fs, deps } = await seedProfile({ mounts: async () => ['/home/user/'] });
    await fs.writeFile(
      '/sessions/index.json',
      JSON.stringify([
        {
          filename: 'a.json',
          title: 'A',
          frozenAt: '2026-01-01T00:00:00Z',
          messageCount: 0,
          sessionId: 'frozen-1',
        },
        {
          filename: 'odd name.json',
          title: 'B',
          frozenAt: '2026-01-01T00:00:00Z',
          messageCount: 0,
        },
        { filename: 'frozen-1', title: 'C', frozenAt: '2026-01-01T00:00:00Z', messageCount: 0 },
      ])
    );
    const plan = await planProfileExport({
      ...deps,
      createTranscriptSource: (k) => {
        const real = deps.createTranscriptSource(k);
        return {
          snapshotCone: (c, s) => real.snapshotCone(c, s),
          snapshotFrozen: (_id, s) => real.snapshotFrozen('frozen-1', s),
        };
      },
    });
    const m = plan.archives[0]!.manifest;
    const names = m.frozen.map((f) => f.transcript);
    expect(names[0]).toBe('frozen/frozen-1.json');
    expect(names[1]).toMatch(/^frozen\/s-[0-9a-f]{16}\.json$/);
    expect(names[2]).toBe('frozen/frozen-1-2.json');
    expect(m.frozen[1]!.id).toBe('odd name.json');
    expect(m.files.some((f) => f.path.startsWith('files/home-user/'))).toBe(false);
    expect(m.skipped).toContainEqual({ path: '/home/user', reason: 'mount' });
  });

  it('cancels when the signal fires', async () => {
    const { deps } = await seedProfile();
    const controller = new AbortController();
    controller.abort();
    await expect(planProfileExport(deps, controller.signal)).rejects.toThrow();
  });
});
