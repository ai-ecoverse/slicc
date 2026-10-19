import {
  PROFILE_MANIFEST_PATH,
  type SliccProfileManifestV1,
  type TranscriptDocumentV1,
  validateSliccProfileManifestV1,
  validateTranscriptDocumentV1,
} from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';
import { describe, expect, it } from 'vitest';
import {
  gitconfigUserSection,
  type ProfileArchivePlan,
  ProfileExportError,
  planProfileExport,
} from '../../src/transcript/profile-export.js';
import {
  ENV_FILE,
  PEM_FILE,
  PNG,
  readStoredZip,
  SECRETS,
  seedProfile,
} from './profile-export-seed.js';

async function collect(archive: ProfileArchivePlan): Promise<Uint8Array> {
  const stream = archive.open();
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream.chunks) chunks.push(chunk);
  const completion = await stream.completion;
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.byteLength;
  }
  expect(completion.byteLength).toBe(total);
  expect(completion.sha256).toBe(sha256(merged));
  expect(total).toBe(archive.byteLength);
  return merged;
}

const text = (data: Uint8Array): string => new TextDecoder().decode(data);
const json = <T>(data: Uint8Array): T => JSON.parse(text(data)) as T;

async function exportSeeded(overrides = {}) {
  const { deps } = await seedProfile(overrides);
  const plan = await planProfileExport(deps);
  const zips = await Promise.all(plan.archives.map(collect));
  return { plan, zips, entries: zips.map(readStoredZip) };
}

describe('planProfileExport — a seeded profile', () => {
  it('writes manifest.json first and a slicc-profile v1 layout', async () => {
    const { plan, entries } = await exportSeeded();
    expect(plan.archives).toHaveLength(1);
    expect(plan.archives[0]!.filename).toBe('slicc6-profile-2026-10-18.zip');
    const [zip] = entries;
    expect(zip![0]!.name).toBe(PROFILE_MANIFEST_PATH);
    const names = zip!.map((e) => e.name).sort();
    const attachment = `attachments/${sha256(PNG)}`;
    expect(names).toEqual(
      [
        PROFILE_MANIFEST_PATH,
        attachment,
        'files/cones/cone/.env',
        'files/cones/cone/.slicc/oauth/xai.json',
        'files/cones/cone/certs/server.pem',
        'files/cones/cone/image.bin',
        'files/cones/cone/notes.md',
        'files/cones/cone/repo/.git/HEAD',
        'files/cones/side-project/.npmrc',
        'files/cones/side-project/app.ts',
        'files/home-user/todo.txt',
        'files/scoops/research-scoop/findings.md',
        'frozen/frozen-1.json',
        'git/gitconfig',
        'licks.json',
        'memory/cone.md',
        'memory/global.md',
        'memory/side-project.md',
        'skills/my-skill/SKILL.md',
        'sprinkles/dash/dash.shtml',
        'transcripts/cone.json',
        'transcripts/side-project.json',
      ].sort()
    );
  });

  it('writes a manifest that validates and lists every entry with its size and sha256', async () => {
    const { entries } = await exportSeeded();
    const zip = entries[0]!;
    const manifest = json<SliccProfileManifestV1>(zip[0]!.data);
    expect(validateSliccProfileManifestV1(manifest)).toEqual({ ok: true });
    expect(manifest).toMatchObject({
      format: 'slicc-profile',
      version: 1,
      exportId: '0b9d6c1e-3f4a-4b5c-8d6e-7f8091a2b3c4',
      producer: { slicc: '6.0.0-test', origin: 'https://www.sliccy.ai' },
      createdAt: '2026-10-18T12:00:00.000Z',
      licks: 'licks.json',
      gitconfig: 'git/gitconfig',
      providers: ['anthropic', 'openai'],
      mcp: [{ name: 'linear', url: 'https://mcp.linear.app/mcp' }],
      secrets: ['github-token', 'mcp-tokens', 'secrets-env'],
    });
    expect(manifest.part).toBeUndefined();
    const listed = new Map(manifest.files.map((f) => [f.path, f]));
    expect(listed.size).toBe(zip.length - 1);
    for (const entry of zip.slice(1)) {
      const file = listed.get(entry.name);
      expect(file, entry.name).toBeDefined();
      expect(file!.size).toBe(entry.data.byteLength);
      expect(file!.sha256).toBe(sha256(entry.data));
    }
    expect(manifest.totals).toMatchObject({
      cones: 2,
      scoops: 1,
      frozen: 1,
      attachments: 1,
      skills: 1,
      sprinkles: 1,
      crontasks: 1,
      tasks: 1,
      webhooks: 1,
      flagged: 4,
      entries: zip.length,
    });
    expect(manifest.totals.bytes).toBe(zip.slice(1).reduce((n, e) => n + e.data.byteLength, 0));
  });

  it('describes cones, scoops and frozen sessions with their transcript conversations', async () => {
    const { entries } = await exportSeeded();
    const manifest = json<SliccProfileManifestV1>(entries[0]![0]!.data);
    expect(manifest.cones).toEqual([
      {
        key: '/workspace::cone_1',
        folder: 'cone',
        name: 'Sliccy',
        transcript: 'transcripts/cone.json',
        conversation: 'cone_1',
        files: 'files/cones/cone/',
        memory: 'memory/cone.md',
        scoops: [
          {
            key: '/scoops/research-scoop/workspace::scoop_research_1',
            folder: 'research-scoop',
            name: 'research',
            conversation: 'scoop_research_1',
            files: 'files/scoops/research-scoop/',
          },
        ],
      },
      {
        key: '/cones/side-project/workspace::cone_2',
        folder: 'side-project',
        name: 'Side project',
        transcript: 'transcripts/side-project.json',
        conversation: 'cone_2',
        files: 'files/cones/side-project/',
        memory: 'memory/side-project.md',
        scoops: [],
      },
    ]);
    expect(manifest.frozen).toEqual([
      {
        id: 'frozen-1',
        title: 'Old chat',
        frozenAt: '2026-10-01T10:00:00.000Z',
        transcript: 'frozen/frozen-1.json',
      },
    ]);
    expect(manifest.skills).toEqual([{ name: 'my-skill', path: 'skills/my-skill/' }]);
    expect(manifest.sprinkles).toEqual([{ name: 'dash', path: 'sprinkles/dash/' }]);
  });

  it('writes valid transcripts whose attachments are content-addressed', async () => {
    const { entries } = await exportSeeded();
    const byName = new Map(entries[0]!.map((e) => [e.name, e.data]));
    for (const name of [
      'transcripts/cone.json',
      'transcripts/side-project.json',
      'frozen/frozen-1.json',
    ]) {
      const doc = json<TranscriptDocumentV1>(byName.get(name)!);
      expect(validateTranscriptDocumentV1(doc), name).toEqual({ ok: true });
    }
    const cone = json<TranscriptDocumentV1>(byName.get('transcripts/cone.json')!);
    expect(cone.conversations.map((c) => [c.id, c.kind])).toEqual([
      ['cone_1', 'cone'],
      ['scoop_research_1', 'scoop'],
    ]);
    const present = cone.attachments.filter((a) => a.present);
    expect(present).toHaveLength(1);
    expect(present[0]!.path).toBe(`attachments/${present[0]!.sha256}`);
    expect(byName.get(present[0]!.path)).toEqual(PNG);
  });

  it('never lets a provider key, token or secret into the zip bytes', async () => {
    const { zips } = await exportSeeded();
    const raw = new TextDecoder('latin1').decode(zips[0]!);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(raw.includes(secret), name).toBe(false);
    }
    expect(raw.includes('mounted, never exported')).toBe(false);
  });

  it('stores credential-like files byte for byte and lists them in flagged[]', async () => {
    const { plan, entries } = await exportSeeded();
    const zip = entries[0]!;
    const manifest = json<SliccProfileManifestV1>(zip[0]!.data);
    const byName = new Map(zip.map((e) => [e.name, e.data]));
    expect(manifest.flagged).toEqual([
      { path: 'files/cones/cone/.env', size: ENV_FILE.length, rule: 'env' },
      { path: 'files/cones/cone/.slicc/oauth/xai.json', size: 32, rule: 'slicc-oauth' },
      { path: 'files/cones/cone/certs/server.pem', size: PEM_FILE.length, rule: 'pem' },
      { path: 'files/cones/side-project/.npmrc', size: 43, rule: 'npmrc' },
    ]);
    expect(text(byName.get('files/cones/cone/.env')!)).toBe(ENV_FILE);
    expect(text(byName.get('files/cones/cone/certs/server.pem')!)).toBe(PEM_FILE);
    expect(plan.summary.flagged.map((f) => f.sourcePath)).toEqual([
      '/workspace/.env',
      '/workspace/.slicc/oauth/xai.json',
      '/workspace/certs/server.pem',
      '/cones/side-project/workspace/.npmrc',
    ]);
  });

  it('redacts text files, memory and licks, and counts what it replaced', async () => {
    const { entries } = await exportSeeded();
    const byName = new Map(entries[0]!.map((e) => [e.name, text(e.data)]));
    expect(byName.get('files/cones/cone/notes.md')).toContain('⟦REDACTED:provider-credential:');
    expect(byName.get('memory/cone.md')).toContain('⟦REDACTED:provider-credential:');
    expect(byName.get('memory/global.md')).toBe('# Global memory\nPrefers tabs.\n');
    const manifest = JSON.parse(byName.get(PROFILE_MANIFEST_PATH)!) as SliccProfileManifestV1;
    expect(manifest.redactionCounts['provider-credential']).toBeGreaterThanOrEqual(4);
    expect(manifest.redactionCounts['secret']).toBeGreaterThanOrEqual(1);
  });

  it('records skipped mounts, caches, hooks and bundled skills', async () => {
    const { entries } = await exportSeeded();
    const manifest = json<SliccProfileManifestV1>(entries[0]![0]!.data);
    expect(manifest.skipped).toEqual(
      expect.arrayContaining([
        { path: '/mnt/project', reason: 'mount' },
        { path: '/workspace/node_modules', reason: 'cache' },
        { path: '/workspace/repo/.git/hooks', reason: 'cache' },
        { path: '/workspace/skills/browser', reason: 'bundled' },
      ])
    );
  });

  it('writes licks raw, with each cron and webhook target resolved to a folder', async () => {
    const { entries } = await exportSeeded();
    const licks = json<{
      crontasks: { scoop?: string; targetFolder: string | null }[];
      tasks: { groupFolder: string }[];
      webhooks: { targetFolder: string | null }[];
    }>(entries[0]!.find((e) => e.name === 'licks.json')!.data);
    expect(licks.crontasks[0]).toMatchObject({ scoop: 'research', targetFolder: 'research-scoop' });
    expect(licks.tasks[0]!.groupFolder).toBe('cone');
    expect(licks.webhooks[0]!.targetFolder).toBeNull();
  });

  it('keeps only the [user] section of the gitconfig', async () => {
    const { entries } = await exportSeeded();
    const git = text(entries[0]!.find((e) => e.name === 'git/gitconfig')!.data);
    expect(git).toBe('[user]\n\tname = Ada\n\temail = ada@example.com\n');
    expect(gitconfigUserSection('[core]\n\tbare = false\n')).toBeNull();
  });

  it('summarises providers, flagged files and what stays behind for the dialog', async () => {
    const { plan } = await exportSeeded();
    expect(plan.summary).toMatchObject({
      providers: ['anthropic', 'openai'],
      mounts: ['/mnt/project'],
      cones: 2,
      scoops: 1,
      frozen: 1,
      skills: 1,
      sprinkles: 1,
      archives: ['slicc6-profile-2026-10-18.zip'],
    });
  });

  it('fails the archive when a file changes between planning and writing', async () => {
    const { fs, deps } = await seedProfile();
    const plan = await planProfileExport(deps);
    await fs.writeFile('/workspace/image.bin', new Uint8Array([9, 9, 9]));
    await expect(collect(plan.archives[0]!)).rejects.toThrow(/changed while exporting/);
  });

  it('skips unreadable frozen sessions instead of failing the export', async () => {
    const { fs, deps } = await seedProfile();
    await fs.writeFile(
      '/sessions/index.json',
      JSON.stringify([
        { filename: 'gone.json', title: 'Gone', frozenAt: '2026-01-01T00:00:00Z', messageCount: 0 },
      ])
    );
    const plan = await planProfileExport(deps);
    expect(plan.archives[0]!.manifest.frozen).toEqual([]);
    expect(plan.archives[0]!.manifest.skipped).toContainEqual({
      path: '/sessions/gone.json',
      reason: 'unreadable',
    });
  });

  it('fails closed when the known-secret redactor is unavailable', async () => {
    const { deps } = await seedProfile({
      knownSecrets: {
        redact: async () => {
          throw new Error('down');
        },
      },
    });
    await expect(planProfileExport(deps)).rejects.toThrow();
  });
});

describe('planProfileExport — size limits and the part split', () => {
  it('splits into one zip per cone plus a profile part when one archive is too big', async () => {
    const single = await exportSeeded();
    const singleManifest = json<SliccProfileManifestV1>(single.entries[0]![0]!.data);
    const limit = single.plan.archives[0]!.byteLength - 1;
    const { plan, entries } = await exportSeeded({ limits: { maxArchiveBytes: limit } });
    expect(plan.archives.map((a) => a.filename)).toEqual([
      'slicc6-profile-2026-10-18-part1of3.zip',
      'slicc6-profile-2026-10-18-part2of3.zip',
      'slicc6-profile-2026-10-18-part3of3.zip',
    ]);
    const manifests = entries.map((zip) => json<SliccProfileManifestV1>(zip[0]!.data));
    manifests.forEach((m, i) => {
      expect(validateSliccProfileManifestV1(m)).toEqual({ ok: true });
      expect(m.exportId).toBe(singleManifest.exportId);
      expect(m.part).toEqual({ index: i + 1, of: 3 });
      expect(m.providers).toEqual(['anthropic', 'openai']);
      expect(plan.archives[i]!.byteLength).toBeLessThanOrEqual(limit);
    });
    expect(manifests.map((m) => m.cones.map((c) => c.folder))).toEqual([
      [],
      ['cone'],
      ['side-project'],
    ]);
    expect(manifests[0]!.frozen).toHaveLength(1);
    expect(manifests[0]!.licks).toBe('licks.json');
    const union = manifests.flatMap((m) => m.files.map((f) => f.path)).sort();
    expect(union).toEqual(singleManifest.files.map((f) => f.path).sort());
  });

  it('splits on the entry ceiling too', async () => {
    const single = await exportSeeded();
    const count = single.entries[0]!.length;
    const { plan } = await exportSeeded({ limits: { maxArchiveEntries: count - 1 } });
    expect(plan.archives).toHaveLength(3);
    for (const archive of plan.archives) {
      expect(archive.manifest.totals.entries).toBeLessThanOrEqual(count - 1);
    }
  });

  it('refuses a cone that does not fit one archive on its own', async () => {
    const { deps } = await seedProfile({ limits: { maxArchiveEntries: 3 } });
    await expect(planProfileExport(deps)).rejects.toBeInstanceOf(ProfileExportError);
    await expect(planProfileExport(deps)).rejects.toThrow(/too big for one archive/);
  });

  it('skips a single file larger than 256 MiB', async () => {
    const big = { byteLength: 256 * 1024 * 1024 + 1 } as Uint8Array;
    const { fs, deps } = await seedProfile();
    const readFile = fs.readFile.bind(fs);
    const vfs = {
      readDir: fs.readDir.bind(fs),
      stat: fs.stat.bind(fs),
      readFile: (async (path: string, opts?: { encoding?: 'utf-8' | 'binary' }) =>
        path === '/workspace/image.bin' ? big : readFile(path, opts)) as typeof deps.vfs.readFile,
    };
    const plan = await planProfileExport({ ...deps, vfs });
    expect(plan.archives[0]!.manifest.skipped).toContainEqual({
      path: '/workspace/image.bin',
      reason: 'too-large',
    });
  });
});
