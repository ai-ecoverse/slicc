/**
 * The version 2 (directory) form of the profile export (slicc#4051): the
 * manifest passes `validateSliccProfileManifest`, files redaction left
 * unchanged under `files/`, `skills/` and `sprinkles/` carry `source` and are
 * not written, and everything else (transcripts, frozen sessions,
 * attachments, memory, licks, gitconfig, redacted files) is written as bytes,
 * with `manifest.json` last.
 */
import {
  PROFILE_MANIFEST_PATH,
  type ProfileFileEntryV2,
  validateSliccProfileManifest,
  validateSliccProfileManifestV2,
} from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';
import { describe, expect, it } from 'vitest';
import {
  type ProfileDirectoryWriter,
  planProfileDirectory,
  profileSourceFor,
} from '../../src/transcript/profile-export.js';
import { ENV_FILE, PNG, SECRETS, seedProfile } from './profile-export-seed.js';

function memoryWriter(): ProfileDirectoryWriter & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    writeFile: async (path, bytes) => {
      files.set(path, bytes);
    },
  };
}

const text = (data: Uint8Array): string => new TextDecoder().decode(data);

async function exportDirectory(overrides = {}) {
  const seeded = await seedProfile(overrides);
  const plan = await planProfileDirectory(seeded.deps);
  const writer = memoryWriter();
  await plan.write(writer);
  return { ...seeded, plan, writer };
}

function row(files: readonly ProfileFileEntryV2[], path: string): ProfileFileEntryV2 {
  const found = files.find((f) => f.path === path);
  if (!found) throw new Error(`no files[] row for ${path}`);
  return found;
}

describe('planProfileDirectory — the version 2 manifest', () => {
  it('passes validateSliccProfileManifest as version 2, with no part', async () => {
    const { plan, writer } = await exportDirectory();
    expect(plan.manifest.version).toBe(2);
    expect(plan.manifest).not.toHaveProperty('part');
    expect(validateSliccProfileManifestV2(plan.manifest)).toEqual({ ok: true });
    const written = JSON.parse(text(writer.files.get(PROFILE_MANIFEST_PATH)!));
    expect(written).toEqual(plan.manifest);
    expect(validateSliccProfileManifest(written)).toEqual({ ok: true });
  });

  it('lives at /slicc-v6-upgrade/<exportId>/', async () => {
    const { plan } = await exportDirectory();
    expect(plan.exportId).toBe('0b9d6c1e-3f4a-4b5c-8d6e-7f8091a2b3c4');
    expect(plan.dir).toBe('/slicc-v6-upgrade/0b9d6c1e-3f4a-4b5c-8d6e-7f8091a2b3c4/');
  });

  it('counts moved and written entries alike in totals', async () => {
    const { plan } = await exportDirectory();
    const { files, totals } = plan.manifest;
    expect(totals.entries).toBe(files.length + 1);
    expect(totals.bytes).toBe(files.reduce((n, f) => n + f.size, 0));
    expect(plan.inPlace).toBe(files.filter((f) => f.source !== undefined).length);
  });
});

describe('planProfileDirectory — source versus bytes', () => {
  it('leaves unchanged workspace, home, skill and sprinkle files in place under /slicc-fs/', async () => {
    const { plan, writer, fs } = await exportDirectory();
    const files = plan.manifest.files;
    const inPlace: [string, string][] = [
      ['files/cones/cone/image.bin', '/slicc-fs/workspace/image.bin'],
      ['files/cones/cone/repo/.git/HEAD', '/slicc-fs/workspace/repo/.git/HEAD'],
      ['files/cones/side-project/app.ts', '/slicc-fs/cones/side-project/workspace/app.ts'],
      [
        'files/scoops/research-scoop/findings.md',
        '/slicc-fs/scoops/research-scoop/workspace/findings.md',
      ],
      ['skills/my-skill/SKILL.md', '/slicc-fs/workspace/skills/my-skill/SKILL.md'],
      ['sprinkles/dash/dash.shtml', '/slicc-fs/shared/sprinkles/dash/dash.shtml'],
    ];
    for (const [path, source] of inPlace) {
      const entry = row(files, path);
      expect(entry.source).toBe(source);
      // size and sha256 are the file's own, as seven checks them after the move.
      const bytes = (await fs.readFile(source.slice('/slicc-fs'.length), {
        encoding: 'binary',
      })) as Uint8Array;
      expect(entry.size).toBe(bytes.byteLength);
      expect(entry.sha256).toBe(sha256(bytes));
      expect(writer.files.has(path)).toBe(false);
    }
  });

  it('leaves flagged credential-like files in place, byte for byte, and still flags them', async () => {
    const { plan, writer } = await exportDirectory();
    const env = row(plan.manifest.files, 'files/cones/cone/.env');
    expect(env.source).toBe('/slicc-fs/workspace/.env');
    expect(env.sha256).toBe(sha256(ENV_FILE));
    expect(writer.files.has('files/cones/cone/.env')).toBe(false);
    expect(plan.manifest.flagged.map((f) => f.path)).toContain('files/cones/cone/.env');
  });

  it('writes transcripts, frozen sessions, attachments, memory, licks and gitconfig as bytes', async () => {
    const { plan, writer } = await exportDirectory();
    const generated = [
      'transcripts/cone.json',
      'transcripts/side-project.json',
      'frozen/frozen-1.json',
      `attachments/${sha256(PNG)}`,
      'memory/cone.md',
      'memory/side-project.md',
      'memory/global.md',
      'licks.json',
      'git/gitconfig',
    ];
    for (const path of generated) {
      const entry = row(plan.manifest.files, path);
      expect(entry.source).toBeUndefined();
      const bytes = writer.files.get(path);
      expect(bytes, path).toBeDefined();
      expect(entry.size).toBe(bytes!.byteLength);
      expect(entry.sha256).toBe(sha256(bytes!));
    }
  });

  it('writes a file whose bytes redaction changed, and never with the secret in it', async () => {
    const { plan, writer } = await exportDirectory();
    for (const path of ['files/cones/cone/notes.md', 'files/home-user/todo.txt']) {
      const entry = row(plan.manifest.files, path);
      expect(entry.source, path).toBeUndefined();
      const written = text(writer.files.get(path)!);
      expect(written).toContain('⟦REDACTED:');
      expect(entry.sha256).toBe(sha256(writer.files.get(path)!));
    }
    const all = [...writer.files.values()].map(text).join('\n');
    for (const secret of Object.values(SECRETS)) expect(all).not.toContain(secret);
  });

  it('writes every row without a source, and only those, with manifest.json last', async () => {
    const order: string[] = [];
    const { deps } = await seedProfile();
    const plan = await planProfileDirectory(deps);
    await plan.write({
      writeFile: async (path) => {
        order.push(path);
      },
    });
    const written = plan.manifest.files.filter((f) => f.source === undefined).map((f) => f.path);
    expect(order.slice(0, -1).sort()).toEqual([...written].sort());
    expect(order.at(-1)).toBe(PROFILE_MANIFEST_PATH);
  });

  it('leaves symlinks and empty directories out', async () => {
    const { fs, deps } = await seedProfile();
    await fs.symlink('/workspace/notes.md', '/workspace/link.md');
    await fs.mkdir('/workspace/empty', { recursive: true });
    const plan = await planProfileDirectory(deps);
    const paths = plan.manifest.files.map((f) => f.path);
    expect(paths).not.toContain('files/cones/cone/link.md');
    expect(paths.some((p) => p.startsWith('files/cones/cone/empty'))).toBe(false);
    expect(plan.manifest.files.some((f) => f.source === '/slicc-fs/workspace/link.md')).toBe(false);
  });

  it('skips a file over 256 MiB instead of moving it', async () => {
    const big = { byteLength: 256 * 1024 * 1024 + 1 } as Uint8Array;
    const { fs, deps } = await seedProfile();
    const readFile = fs.readFile.bind(fs);
    const vfs = {
      readDir: fs.readDir.bind(fs),
      stat: fs.stat.bind(fs),
      readFile: (async (path: string, opts?: { encoding?: 'utf-8' | 'binary' }) =>
        path === '/workspace/image.bin' ? big : readFile(path, opts)) as typeof deps.vfs.readFile,
    };
    const plan = await planProfileDirectory({ ...deps, vfs });
    expect(plan.manifest.files.some((f) => f.path === 'files/cones/cone/image.bin')).toBe(false);
    expect(plan.manifest.skipped).toContainEqual({
      path: '/workspace/image.bin',
      reason: 'too-large',
    });
  });

  it('reports reading and writing progress up to the total', async () => {
    const { deps } = await seedProfile();
    const seen: string[] = [];
    const plan = await planProfileDirectory(deps, {
      onProgress: (phase, done, total) => seen.push(`${phase}:${done}/${total}`),
    });
    await plan.write(memoryWriter(), {
      onProgress: (phase, done, total) => seen.push(`${phase}:${done}/${total}`),
    });
    const last = (phase: string) => seen.filter((s) => s.startsWith(phase)).at(-1)!;
    const [rd, rt] = last('reading').slice('reading:'.length).split('/');
    const [wd, wt] = last('writing').slice('writing:'.length).split('/');
    expect(rd).toBe(rt);
    expect(wd).toBe(wt);
    expect(Number(wt)).toBe(plan.manifest.files.length - plan.inPlace + 1);
  });

  it('fails when the directory cannot be written', async () => {
    const { deps } = await seedProfile();
    const plan = await planProfileDirectory(deps);
    await expect(
      plan.write({
        writeFile: async () => {
          throw new Error('quota');
        },
      })
    ).rejects.toThrow('quota');
  });
});

describe('profileSourceFor', () => {
  it('names a /slicc-fs/ path only for unchanged files under files/, skills/ and sprinkles/', () => {
    expect(profileSourceFor({ path: 'files/home-user/a', unchangedFrom: '/home/user/a' })).toBe(
      '/slicc-fs/home/user/a'
    );
    expect(profileSourceFor({ path: 'files/home-user/a' })).toBeUndefined();
    expect(
      profileSourceFor({ path: 'memory/cone.md', unchangedFrom: '/workspace/CLAUDE.md' })
    ).toBeUndefined();
  });

  it('never names the sidecar or an unsafe path', () => {
    expect(
      profileSourceFor({
        path: 'files/cones/cone/.metadata.json',
        unchangedFrom: '/.metadata.json',
      })
    ).toBeUndefined();
    expect(
      profileSourceFor({ path: 'files/cones/cone/a\\b', unchangedFrom: '/workspace/a\\b' })
    ).toBeUndefined();
  });
});
