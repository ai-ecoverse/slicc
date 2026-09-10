import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGelatiereLickBody,
  coerceSuggestions,
  DEFAULT_GELATIERE_INTERVAL_HOURS,
  DEFAULT_GELATIERE_MD,
  DEFAULT_GELATIERE_NIGHTLY_CRON,
  DEFAULT_MAX_SUGGESTIONS,
  describeGelatiereLick,
  dismissGelatiereSuggestion,
  GELATIERE_INSTRUCTIONS_PATH,
  GELATIERE_SKILL_PATH,
  GELATIERE_STATE_PATH,
  GELATIERE_SUGGESTIONS_ACTION,
  GELATIERE_SUGGESTIONS_PATH,
  type GelatiereSuggestion,
  type GelatiereVfs,
  isPassDue,
  loadGelatiereConfig,
  MAX_STORED_SUGGESTIONS,
  mergeSuggestions,
  openSuggestions,
  parseGelatiereDocument,
  readGelatiereState,
  readGelatiereSuggestions,
  recordPass,
  suggestionsSince,
  takeGelatiereSuggestion,
  takenSuggestions,
} from '../../src/base/gelatiere-store.js';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';

interface FakeVfs extends GelatiereVfs {
  files: Map<string, string>;
}

function fakeVfs(initial: Record<string, string> = {}): FakeVfs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: vi.fn(async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    }),
    writeFile: vi.fn(async (path: string, body: string) => {
      files.set(path, body);
    }),
    mkdir: vi.fn(async () => {}),
  };
}

function suggestion(overrides: Partial<GelatiereSuggestion> = {}): GelatiereSuggestion {
  return {
    id: 'skill-github',
    kind: 'skill',
    title: 'Install the GitHub skill',
    body: 'You open GitHub by hand in most sessions.',
    skill: 'github',
    install: 'upskill ai-ecoverse/skills --path skills/ --skill github',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const NOW = new Date('2026-09-09T12:00:00.000Z');

describe('parseGelatiereDocument', () => {
  it('reads the bundled default', () => {
    const config = parseGelatiereDocument(DEFAULT_GELATIERE_MD);
    expect(config.intervalHours).toBe(DEFAULT_GELATIERE_INTERVAL_HOURS);
    expect(config.nightly).toBe(DEFAULT_GELATIERE_NIGHTLY_CRON);
    expect(config.maxSuggestions).toBe(DEFAULT_MAX_SUGGESTIONS);
    expect(config.instructions).toContain('gelatiere suggest');
    expect(config.instructions).toContain('gelatiere deliver');
    expect(config.instructions).toContain('catalog.json');
    // The unit reads the file raw — no runtime placeholders may be left in it.
    expect(config.instructions).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('honours custom values and clamps the per-pass cap', () => {
    const config = parseGelatiereDocument(`---
intervalHours: 6
nightly: "30 2 * * *"
maxSuggestions: 50
---
Body`);
    expect(config.intervalHours).toBe(6);
    expect(config.nightly).toBe('30 2 * * *');
    expect(config.maxSuggestions).toBe(10);
    expect(config.instructions).toBe('Body');
  });

  it('rejects curator-only keys, bad numbers, and a malformed cron', () => {
    expect(() => parseGelatiereDocument('---\nwritablePaths: [/x/]\n---\nbody')).toThrow(
      'Unsupported or empty frontmatter field: writablePaths'
    );
    expect(() => parseGelatiereDocument('---\nintervalHours: -1\n---\nbody')).toThrow(
      'intervalHours must be positive'
    );
    expect(() => parseGelatiereDocument('---\nnightly: "3am"\n---\nbody')).toThrow(
      'nightly must be a 5-field cron expression'
    );
  });

  it('loadGelatiereConfig falls back to the bundled default on a broken file', async () => {
    resetLoggerDedupForTests();
    const config = await loadGelatiereConfig(
      fakeVfs({ [GELATIERE_INSTRUCTIONS_PATH]: 'no frontmatter here' })
    );
    expect(config.nightly).toBe(DEFAULT_GELATIERE_NIGHTLY_CRON);
    const custom = await loadGelatiereConfig(
      fakeVfs({ [GELATIERE_INSTRUCTIONS_PATH]: '---\nintervalHours: 2\n---\nbody' })
    );
    expect(custom.intervalHours).toBe(2);
  });
});

describe('ledger and store', () => {
  it('isPassDue: never ran, unparseable stamp, or interval elapsed', () => {
    expect(isPassDue({ passes: 0 }, NOW, 24)).toBe(true);
    expect(isPassDue({ passes: 1, lastPassAt: 'garbage' }, NOW, 24)).toBe(true);
    expect(isPassDue({ passes: 1, lastPassAt: '2026-09-08T11:00:00.000Z' }, NOW, 24)).toBe(true);
    expect(isPassDue({ passes: 1, lastPassAt: '2026-09-08T13:00:00.000Z' }, NOW, 24)).toBe(false);
  });

  it('readGelatiereSuggestions tolerates a missing, corrupt, or partly invalid store', async () => {
    expect(await readGelatiereSuggestions(fakeVfs())).toEqual([]);
    expect(
      await readGelatiereSuggestions(fakeVfs({ [GELATIERE_SUGGESTIONS_PATH]: '{not json' }))
    ).toEqual([]);
    const stored = [
      suggestion(),
      { id: 'x', kind: 'tip', title: 'no body' },
      { ...suggestion({ id: 'tip-old', kind: 'tip' }), dismissedAt: '2026-09-02T00:00:00.000Z' },
    ];
    const list = await readGelatiereSuggestions(
      fakeVfs({ [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify(stored) })
    );
    expect(list.map((s) => s.id)).toEqual(['skill-github', 'tip-old']);
    expect(list[1].dismissedAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('readGelatiereState tolerates a missing or malformed ledger', async () => {
    expect(await readGelatiereState(fakeVfs())).toEqual({ passes: 0 });
    expect(await readGelatiereState(fakeVfs({ [GELATIERE_STATE_PATH]: '[]' }))).toEqual({
      passes: 0,
    });
    expect(
      await readGelatiereState(
        fakeVfs({
          [GELATIERE_STATE_PATH]: JSON.stringify({
            passes: 3,
            lastPassAt: 'x',
            lastDeliveredAt: 7,
          }),
        })
      )
    ).toEqual({ passes: 3, lastPassAt: 'x' });
  });

  it('suggestionsSince returns open entries newer than the stamp (all when absent)', () => {
    const list = [
      suggestion({ id: 'new', createdAt: '2026-09-09T10:00:00.000Z' }),
      suggestion({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      suggestion({ id: 'gone', createdAt: '2026-09-09T11:00:00.000Z', dismissedAt: 'x' }),
    ];
    expect(suggestionsSince(list, undefined).map((s) => s.id)).toEqual(['new', 'old']);
    expect(suggestionsSince(list, '2026-09-05T00:00:00.000Z').map((s) => s.id)).toEqual(['new']);
    expect(suggestionsSince(list, 'garbage').map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('dismissGelatiereSuggestion stamps one open entry and refuses unknown or dismissed ids', async () => {
    const vfs = fakeVfs({
      [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([
        suggestion(),
        suggestion({ id: 'tip-a', kind: 'tip', dismissedAt: '2026-09-02T00:00:00.000Z' }),
      ]),
    });
    expect(await dismissGelatiereSuggestion(vfs, 'skill-github', NOW)).toBe(true);
    const after = await readGelatiereSuggestions(vfs);
    expect(after[0].dismissedAt).toBe(NOW.toISOString());
    expect(openSuggestions(after)).toEqual([]);
    expect(await dismissGelatiereSuggestion(vfs, 'skill-github', NOW)).toBe(false);
    expect(await dismissGelatiereSuggestion(vfs, 'nope', NOW)).toBe(false);
  });

  it('takeGelatiereSuggestion stamps takenAt and takes it out of the open set, not the store', async () => {
    const vfs = fakeVfs({
      [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([suggestion(), suggestion({ id: 'tip-a' })]),
    });
    expect(await takeGelatiereSuggestion(vfs, 'skill-github', NOW)).toBe(true);
    const after = await readGelatiereSuggestions(vfs);
    expect(after[0].takenAt).toBe(NOW.toISOString());
    expect(after[0].dismissedAt).toBeUndefined();
    expect(openSuggestions(after).map((s) => s.id)).toEqual(['tip-a']);
    expect(takenSuggestions(after).map((s) => s.id)).toEqual(['skill-github']);
    // A settled card cannot be settled again either way.
    expect(await takeGelatiereSuggestion(vfs, 'skill-github', NOW)).toBe(false);
    expect(await dismissGelatiereSuggestion(vfs, 'skill-github', NOW)).toBe(false);
  });

  it('serializes concurrent settlements so neither write clobbers the other', async () => {
    // Two card clicks in one tick: dismiss one suggestion, take another.
    const vfs = fakeVfs({
      [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([suggestion(), suggestion({ id: 'tip-a' })]),
    });
    const [took, dismissed] = await Promise.all([
      takeGelatiereSuggestion(vfs, 'skill-github', NOW),
      dismissGelatiereSuggestion(vfs, 'tip-a', NOW),
    ]);
    expect(took).toBe(true);
    expect(dismissed).toBe(true);
    const after = await readGelatiereSuggestions(vfs);
    expect(after.find((s) => s.id === 'skill-github')?.takenAt).toBe(NOW.toISOString());
    expect(after.find((s) => s.id === 'tip-a')?.dismissedAt).toBe(NOW.toISOString());
  });

  it('round-trips takenAt through the store file', async () => {
    const vfs = fakeVfs({
      [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([
        suggestion({ takenAt: '2026-09-03T00:00:00.000Z' }),
        suggestion({ id: 'tip-a', takenAt: 42 as unknown as string }),
      ]),
    });
    const read = await readGelatiereSuggestions(vfs);
    expect(read[0].takenAt).toBe('2026-09-03T00:00:00.000Z');
    expect(read[1].takenAt).toBeUndefined();
  });
});

describe('coerceSuggestions', () => {
  it('accepts the candidates shape (wrapped or bare), slugs ids, trims and caps', () => {
    const out = coerceSuggestions(
      {
        suggestions: [
          {
            id: 'Skill GitHub!!',
            kind: 'skill',
            title: '  Install GitHub  ',
            body: 'b',
            skill: 'github',
            install: 'upskill x',
            url: 'https://www.sliccy.com/skills/github',
            evidence: 'Tuesday',
            createdAt: 'agent-supplied, ignored',
          },
          { kind: 'use-case', title: 'Watch the deploy folder', body: 'b', prompt: 'p' },
          { kind: 'tip', title: 'dup', body: 'b', id: 'skill-github' },
          { kind: 'bogus', title: 't', body: 'b' },
          { kind: 'tip', title: 'no body' },
          'garbage',
        ],
      },
      '2026-09-09T12:00:00.000Z'
    );
    expect(out).toEqual([
      {
        id: 'skill-github',
        kind: 'skill',
        title: 'Install GitHub',
        body: 'b',
        skill: 'github',
        install: 'upskill x',
        url: 'https://www.sliccy.com/skills/github',
        evidence: 'Tuesday',
        createdAt: '2026-09-09T12:00:00.000Z',
      },
      {
        id: 'use-case-watch-the-deploy-folder',
        kind: 'use-case',
        title: 'Watch the deploy folder',
        body: 'b',
        prompt: 'p',
        createdAt: '2026-09-09T12:00:00.000Z',
      },
    ]);
    expect(coerceSuggestions([suggestion(), suggestion({ id: 'b' })], 'now', 1)).toHaveLength(1);
    expect(coerceSuggestions(undefined, 'now')).toEqual([]);
    expect(coerceSuggestions('nope', 'now')).toEqual([]);
  });

  it('drops non-http(s) urls — the one field that renders as an href, not text', () => {
    const entry = (url: string) => ({ kind: 'tip', title: 't', body: 'b', url });
    const urls = (raw: string[]) =>
      coerceSuggestions(
        raw.map((u) => ({ ...entry(u), id: `u${raw.indexOf(u)}` })),
        'now'
      ).map((s) => s.url);
    expect(
      urls([
        'https://www.sliccy.com/skills',
        'http://localhost:5710/x',
        'javascript:alert(1)',
        'data:text/html,<script>1</script>',
        'vbscript:x',
        'not a url',
      ])
    ).toEqual([
      'https://www.sliccy.com/skills',
      'http://localhost:5710/x',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('mergeSuggestions', () => {
  it('prepends new ids, keeps existing entries (and their dismissal) verbatim', () => {
    const existing = [suggestion({ id: 'a', dismissedAt: '2026-09-02T00:00:00.000Z' })];
    const { merged, added } = mergeSuggestions(existing, [
      suggestion({ id: 'a', title: 'resurrected?' }),
      suggestion({ id: 'b' }),
    ]);
    expect(added.map((s) => s.id)).toEqual(['b']);
    expect(merged.map((s) => s.id)).toEqual(['b', 'a']);
    expect(merged[1].title).toBe('Install the GitHub skill');
    expect(merged[1].dismissedAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('trims dismissed entries before open ones past the cap', () => {
    const existing: GelatiereSuggestion[] = [];
    for (let i = 0; i < MAX_STORED_SUGGESTIONS; i += 1) {
      existing.push(suggestion({ id: `s${i}`, dismissedAt: i % 2 ? 'x' : undefined }));
    }
    const { merged } = mergeSuggestions(existing, [suggestion({ id: 'new' })]);
    expect(merged).toHaveLength(MAX_STORED_SUGGESTIONS);
    expect(merged[0].id).toBe('new');
    expect(merged.find((s) => s.id === 's39')).toBeUndefined();
    expect(merged.find((s) => s.id === 's38')).toBeDefined();
  });

  it('drops the oldest open entry only when nothing dismissed is left', () => {
    const existing = Array.from({ length: 3 }, (_, i) => suggestion({ id: `s${i}` }));
    const { merged } = mergeSuggestions(existing, [suggestion({ id: 'new' })], 3);
    expect(merged.map((s) => s.id)).toEqual(['new', 's0', 's1']);
  });

  it('evicts dismissed before taken before open past the cap', () => {
    const existing = [
      suggestion({ id: 'open-1' }),
      suggestion({ id: 'taken-1', takenAt: 'x' }),
      suggestion({ id: 'dismissed-1', dismissedAt: 'x' }),
    ];
    const once = mergeSuggestions(existing, [suggestion({ id: 'new-1' })], 3);
    expect(once.merged.map((s) => s.id)).toEqual(['new-1', 'open-1', 'taken-1']);
    const twice = mergeSuggestions(once.merged, [suggestion({ id: 'new-2' })], 3);
    expect(twice.merged.map((s) => s.id)).toEqual(['new-2', 'new-1', 'open-1']);
  });
});

describe('recordPass', () => {
  beforeEach(() => resetLoggerDedupForTests());
  afterEach(() => vi.restoreAllMocks());

  it('validates, merges, stamps the ledger, and reports added vs open', async () => {
    const vfs = fakeVfs({
      [GELATIERE_SUGGESTIONS_PATH]: JSON.stringify([
        suggestion({ dismissedAt: '2026-09-02T00:00:00.000Z' }),
        suggestion({ id: 'use-case-old', kind: 'use-case', prompt: 'p' }),
      ]),
      [GELATIERE_STATE_PATH]: JSON.stringify({ passes: 2, lastDeliveredAt: 'd' }),
    });
    const result = await recordPass(
      vfs,
      { suggestions: [suggestion(), suggestion({ id: 'tip-new', kind: 'tip', title: 'New tip' })] },
      NOW
    );
    expect(result.added.map((s) => s.id)).toEqual(['tip-new']);
    expect(result.open.map((s) => s.id)).toEqual(['tip-new', 'use-case-old']);
    const stored = JSON.parse(vfs.files.get(GELATIERE_SUGGESTIONS_PATH) ?? '[]');
    expect(stored.map((s: GelatiereSuggestion) => s.id)).toEqual([
      'tip-new',
      'skill-github',
      'use-case-old',
    ]);
    expect(stored[0].createdAt).toBe(NOW.toISOString());
    expect(stored[1].dismissedAt).toBe('2026-09-02T00:00:00.000Z');
    expect(JSON.parse(vfs.files.get(GELATIERE_STATE_PATH) ?? '{}')).toEqual({
      passes: 3,
      lastPassAt: NOW.toISOString(),
      lastDeliveredAt: 'd',
    });
  });

  it('caps a pass at maxSuggestions from the instruction file', async () => {
    const vfs = fakeVfs({ [GELATIERE_INSTRUCTIONS_PATH]: '---\nmaxSuggestions: 1\n---\nbody' });
    const result = await recordPass(vfs, [suggestion({ id: 'a' }), suggestion({ id: 'b' })], NOW);
    expect(result.added.map((s) => s.id)).toEqual(['a']);
  });
});

describe('buildGelatiereLickBody', () => {
  it('announces counts, carries at most five suggestions, and points at the skill (no hint prose)', () => {
    const open = Array.from({ length: 7 }, (_, i) => suggestion({ id: `s${i}` }));
    const body = buildGelatiereLickBody(open.slice(0, 2), open);
    expect(body.action).toBe(GELATIERE_SUGGESTIONS_ACTION);
    expect(body.data.added).toBe(2);
    expect(body.data.open).toBe(7);
    expect(body.data.suggestions).toHaveLength(5);
    expect(body.data.path).toBe(GELATIERE_SUGGESTIONS_PATH);
    expect(body.data.skill).toBe(GELATIERE_SKILL_PATH);
    expect(body.data).not.toHaveProperty('hint');
  });
});

describe('describeGelatiereLick', () => {
  const fenced = (body: unknown) =>
    `[Sprinkle Event: gelatiere]\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``;

  it('summarises a delivery with counts and titles, never the JSON', () => {
    const body = buildGelatiereLickBody(
      [suggestion({ id: 'a', title: 'Install GitHub' })],
      [
        suggestion({ id: 'a', title: 'Install GitHub' }),
        suggestion({ id: 'b', title: 'Save the loop as a workflow' }),
      ]
    );
    expect(describeGelatiereLick(fenced(body))).toEqual({
      action: GELATIERE_SUGGESTIONS_ACTION,
      headline: '1 new suggestion (2 open) — the cards are in the welcome sprinkle.',
      titles: ['Install GitHub', 'Save the loop as a workflow'],
    });
    const nothing = buildGelatiereLickBody([], [suggestion({ id: 'a' })]);
    expect(describeGelatiereLick(fenced(nothing))?.headline).toBe(
      'Nothing new — 1 open suggestion in the welcome card.'
    );
  });

  it('describes the licks the gelatiere itself receives', () => {
    expect(
      describeGelatiereLick(fenced({ action: 'session-settled', data: { cone: 'cone-bakery' } }))
    ).toEqual({
      action: 'session-settled',
      headline: 'A session ended in cone-bakery — time for a pass.',
      titles: [],
    });
    expect(
      describeGelatiereLick(fenced({ action: 'run', data: { requestedBy: 'cone-research' } }))
        ?.headline
    ).toBe('cone-research asked for a pass now.');
    expect(describeGelatiereLick(fenced({ action: 'odd' }))?.headline).toBe('gelatiere: odd');
  });

  it('returns null for unreadable bodies', () => {
    expect(describeGelatiereLick('[Sprinkle Event: gelatiere] no json')).toBeNull();
    expect(describeGelatiereLick('{not json}')).toBeNull();
    expect(describeGelatiereLick('{"data":{}}')).toBeNull();
  });
});
