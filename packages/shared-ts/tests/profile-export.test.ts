import { describe, expect, it } from 'vitest';
import {
  isSafeProfileEntryPath,
  PROFILE_FLAG_RULES,
  profileArchiveFilename,
  profileFlagRuleFor,
  type SliccProfileManifestV1,
  validateSliccProfileManifestV1,
} from '../src/profile-export.js';

function manifest(): SliccProfileManifestV1 {
  return {
    format: 'slicc-profile',
    version: 1,
    exportId: '0b9d6c1e-3f4a-4b5c-8d6e-7f8091a2b3c4',
    producer: { slicc: '6.0.0', origin: 'https://www.sliccy.ai' },
    createdAt: '2026-10-18T12:00:00.000Z',
    cones: [
      {
        key: '/workspace::cone_1',
        folder: 'cone',
        name: 'Sliccy',
        transcript: 'transcripts/cone.json',
        conversation: 'cone_1',
        files: 'files/cones/cone/',
        memory: null,
        scoops: [
          {
            key: '/scoops/r/workspace::scoop_r',
            folder: 'r',
            name: 'r',
            conversation: null,
            files: null,
          },
        ],
      },
    ],
    frozen: [{ id: 'f1', title: 'Old', frozenAt: null, transcript: 'frozen/f1.json' }],
    skills: [{ name: 'my-skill', path: 'skills/my-skill/' }],
    sprinkles: [],
    licks: 'licks.json',
    gitconfig: null,
    files: [
      { path: 'transcripts/cone.json', size: 2, sha256: 'a'.repeat(64) },
      { path: 'files/cones/cone/.env', size: 3, sha256: 'b'.repeat(64) },
      { path: 'frozen/f1.json', size: 2, sha256: 'c'.repeat(64) },
      { path: 'skills/my-skill/SKILL.md', size: 1, sha256: 'd'.repeat(64) },
      { path: 'licks.json', size: 2, sha256: 'e'.repeat(64) },
    ],
    skipped: [{ path: '/mnt/x', reason: 'mount' }],
    flagged: [{ path: 'files/cones/cone/.env', size: 3, rule: 'env' }],
    providers: ['anthropic'],
    mcp: [{ name: 'linear', url: 'https://mcp.linear.app/mcp' }],
    secrets: ['github-token'],
    redactionCounts: { 'api-key': 1 },
    totals: {
      cones: 1,
      scoops: 1,
      frozen: 1,
      files: 1,
      bytes: 10,
      entries: 6,
      attachments: 0,
      skills: 1,
      sprinkles: 0,
      crontasks: 0,
      tasks: 0,
      webhooks: 0,
      flagged: 1,
    },
  };
}

type Mutator = (m: SliccProfileManifestV1 & { [key: string]: unknown }) => void;

describe('validateSliccProfileManifestV1', () => {
  it('accepts a well-formed manifest, with or without part', () => {
    expect(validateSliccProfileManifestV1(manifest())).toEqual({ ok: true });
    expect(validateSliccProfileManifestV1({ ...manifest(), part: { index: 2, of: 3 } })).toEqual({
      ok: true,
    });
  });

  const cases: [string, Mutator, RegExp][] = [
    ['format', (m) => void (m.format = 'x' as never), /format/],
    ['version', (m) => void (m.version = 2 as never), /version/],
    ['exportId', (m) => void (m.exportId = 'nope'), /exportId/],
    ['producer', (m) => void (m.producer = null as never), /producer must be an object/],
    ['producer.origin', (m) => void (m.producer = { slicc: '6' } as never), /producer\.origin/],
    ['createdAt', (m) => void (m.createdAt = 'yesterday'), /createdAt/],
    ['part shape', (m) => void (m.part = { index: 'a' } as never), /part must be/],
    ['part range', (m) => void (m.part = { index: 4, of: 3 }), /part\.index/],
    ['licks', (m) => void (m.licks = 3 as never), /licks/],
    ['cones array', (m) => void (m.cones = {} as never), /cones must be an array/],
    ['cone object', (m) => void (m.cones = [3] as never), /cones\[0\] must be an object/],
    ['cone key', (m) => void ((m.cones[0] as never as { key: number }).key = 1), /key/],
    ['cone folder', (m) => void (m.cones[0]!.folder = 'Bad Folder'), /folder must match/],
    ['cone memory', (m) => void (m.cones[0]!.memory = 1 as never), /memory/],
    ['scoop object', (m) => void (m.cones[0]!.scoops = [null] as never), /scoops\[0\]/],
    ['scoop name', (m) => void (m.cones[0]!.scoops[0]!.name = 1 as never), /name/],
    ['scoop folder', (m) => void (m.cones[0]!.scoops[0]!.folder = '../x'), /folder/],
    ['scoop files', (m) => void (m.cones[0]!.scoops[0]!.files = 1 as never), /files/],
    ['frozen object', (m) => void (m.frozen = [1] as never), /frozen\[0\]/],
    ['frozen id', (m) => void (m.frozen[0]!.id = 1 as never), /frozen\[0\]\.id/],
    ['frozen frozenAt', (m) => void (m.frozen[0]!.frozenAt = 1 as never), /frozenAt/],
    ['skill object', (m) => void (m.skills = [1] as never), /skills\[0\]/],
    ['skill name', (m) => void (m.skills[0]!.name = 1 as never), /skills\[0\]\.name/],
    ['skill path', (m) => void (m.skills[0]!.path = 'skills/x'), /end in/],
    ['file object', (m) => void (m.files = [1] as never), /files\[0\] must be/],
    ['file path', (m) => void (m.files[0]!.path = '../x'), /safe relative/],
    ['file manifest', (m) => void (m.files[0]!.path = 'manifest.json'), /manifest/],
    ['file size', (m) => void (m.files[0]!.size = -1), /size/],
    ['file sha', (m) => void (m.files[0]!.sha256 = 'ABC'), /sha256/],
    ['skipped path', (m) => void (m.skipped = [{}] as never), /skipped\[0\]\.path/],
    ['skipped reason', (m) => void (m.skipped[0]!.reason = 'x' as never), /reason/],
    ['flagged path', (m) => void (m.flagged = [1] as never), /flagged\[0\]\.path/],
    ['flagged size', (m) => void (m.flagged[0]!.size = 1.5), /size/],
    ['flagged rule', (m) => void (m.flagged[0]!.rule = 'x' as never), /rule/],
    ['providers', (m) => void (m.providers = [1] as never), /providers\[0\]/],
    ['mcp object', (m) => void (m.mcp = [1] as never), /mcp\[0\]/],
    ['mcp url', (m) => void (m.mcp = [{ name: 'x' }] as never), /mcp\[0\]\.url/],
    ['secrets', (m) => void (m.secrets = ['api-keys'] as never), /secrets\[0\]/],
    ['totals', (m) => void (m.totals = null as never), /totals must be/],
    ['totals field', (m) => void (m.totals.bytes = -1), /totals\.bytes/],
    ['redactionCounts', (m) => void (m.redactionCounts = [] as never), /redactionCounts/],
    ['redaction count', (m) => void (m.redactionCounts = { x: -1 }), /redactionCounts\.x/],
    ['duplicate file', (m) => void m.files.push({ ...m.files[0]! }), /twice/],
    [
      'missing transcript',
      (m) => void (m.cones[0]!.transcript = 'transcripts/nope.json'),
      /not listed/,
    ],
    ['empty prefix', (m) => void (m.cones[0]!.files = 'files/cones/nope/'), /no entry/],
    ['missing licks', (m) => void (m.licks = 'nope.json'), /not listed/],
    ['missing flagged', (m) => void (m.flagged[0]!.path = 'files/x'), /flagged/],
  ];
  it.each(cases)('rejects a bad %s', (_name, mutate, error) => {
    const m = manifest() as SliccProfileManifestV1 & { [key: string]: unknown };
    mutate(m);
    const result = validateSliccProfileManifestV1(m);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(error);
  });

  it('rejects a non-object', () => {
    expect(validateSliccProfileManifestV1([])).toEqual({
      ok: false,
      error: 'manifest must be an object',
    });
  });
});

describe('profileFlagRuleFor', () => {
  it.each([
    ['/workspace/.env', 'env'],
    ['/workspace/app/.env.local', 'env'],
    ['/workspace/certs/KEY.PEM', 'pem'],
    ['/home/user/.git-credentials', 'git-credentials'],
    ['/cones/x/workspace/.npmrc', 'npmrc'],
    ['/workspace/.slicc/oauth/xai.json', 'slicc-oauth'],
    ['/workspace/notes.md', null],
    ['/workspace/.environment', null],
    ['/workspace/.slicc/oauth', null],
  ])('%s → %s', (path, rule) => {
    expect(profileFlagRuleFor(path)).toBe(rule);
  });

  it('covers every documented rule', () => {
    expect(PROFILE_FLAG_RULES).toEqual(['env', 'pem', 'git-credentials', 'npmrc', 'slicc-oauth']);
  });
});

describe('profileArchiveFilename / isSafeProfileEntryPath', () => {
  it('names single and split archives', () => {
    expect(profileArchiveFilename('2026-10-18T12:00:00Z')).toBe('slicc6-profile-2026-10-18.zip');
    expect(profileArchiveFilename('2026-10-18T12:00:00Z', { index: 2, of: 3 })).toBe(
      'slicc6-profile-2026-10-18-part2of3.zip'
    );
  });

  it.each([
    ['files/cones/cone/a.txt', true],
    ['', false],
    ['/abs', false],
    ['a/../b', false],
    ['a//b', false],
    ['./a', false],
    ['a\\b', false],
    ['a\0b', false],
    ['C:/x', false],
  ])('%j → %s', (path, ok) => {
    expect(isSafeProfileEntryPath(path)).toBe(ok);
  });
});
