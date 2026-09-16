import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeFlags,
  checkRepo,
  findFlagCallSites,
  isConstantAcrossFloats,
  parseFeatureFlagFloatUnion,
  parseFeatureFlagIdUnion,
  parseRegistry,
  parseSince,
  parseWorkerFallbackKeys,
  parseWranglerFlagKeys,
  STALE_DAYS,
  stripComments,
  stripJsonc,
} from './check-dead-flags.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-dead-flags.mjs');

const REGISTRY = `
export type FeatureFlagFloat = 'standalone' | 'cherry';
export type FeatureFlagId = 'live-flag' | 'parked-flag';

const FEATURE_FLAGS = Object.freeze([
  Object.freeze({
    id: 'live-flag',
    defaultValue: 'off',
    since: '2026-09-01',
  }),
  Object.freeze({
    // unused-flag-ok: waiting on the host API
    id: 'parked-flag',
    defaultValue: 'off',
    since: '2026-01-01',
  }),
]);
`;

function runGuard(args = []) {
  try {
    return {
      code: 0,
      out: execFileSync('node', [scriptPath, ...args], { encoding: 'utf8' }),
    };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

describe('check-dead-flags: parsers', () => {
  it('reads the FeatureFlagId union', () => {
    expect(parseFeatureFlagIdUnion(REGISTRY).map((e) => e.id)).toEqual([
      'live-flag',
      'parked-flag',
    ]);
  });

  it('reads FeatureFlagFloat members', () => {
    expect(parseFeatureFlagFloatUnion(REGISTRY)).toEqual(['standalone', 'cherry']);
  });

  it('ignores braces inside registry comments when splitting entries', () => {
    const source = `
const FEATURE_FLAGS = Object.freeze([
  Object.freeze({
    id: 'compact-on-idle',
    defaultValue: 'on',
    since: '2026-09-02',
    // (\`IdleCompaction.gate\`), {floatDefaults} not used
  }),
  Object.freeze({
    id: 'memory-v2',
    defaultValue: 'off',
    since: '2026-09-10',
  }),
]);
`;
    expect(parseRegistry(source).map((e) => e.id)).toEqual(['compact-on-idle', 'memory-v2']);
  });

  it('reads registry ids, since, waivers, and floatDefaults', () => {
    const source = `
const FEATURE_FLAGS = Object.freeze([
  Object.freeze({
    id: 'multiple-cones',
    defaultValue: 'on',
    since: '2026-08-21',
    floatDefaults: Object.freeze({ cherry: 'off' }),
  }),
  Object.freeze({
    id: 'parked',
    defaultValue: 'off',
    since: '2026-01-01',
  }), // unused-dep-ok: still deciding
]);
`;
    const entries = parseRegistry(source);
    expect(entries).toEqual([
      expect.objectContaining({
        id: 'multiple-cones',
        defaultValue: 'on',
        since: '2026-08-21',
        floatDefaults: { cherry: 'off' },
        waiver: null,
      }),
      expect.objectContaining({
        id: 'parked',
        waiver: 'still deciding',
      }),
    ]);
  });

  it('reads FALLBACK_BASE_FLAGS keys', () => {
    const keys = parseWorkerFallbackKeys(`
const FALLBACK_BASE_FLAGS: FlagStringMap = {
  'experimental-settings': 'on',
};
`);
    expect(keys.map((k) => k.id)).toEqual(['experimental-settings']);
  });

  it('reads wrangler FEATURE_FLAGS keys from production and staging', () => {
    const keys = parseWranglerFlagKeys(`{
      "vars": {
        "FEATURE_FLAGS": {
          "base": { "live-flag": "on" },
          "floats": { "cherry": { "live-flag": "off" } }
        }
      },
      "env": {
        "staging": {
          "vars": {
            "FEATURE_FLAGS": {
              "base": { "live-flag": "on", "ghost-flag": "off" },
              "floats": { "standalone": {} }
            }
          }
        }
      }
    }`);
    expect(keys.map((k) => `${k.path}:${k.id}`).sort()).toEqual([
      'production.base:live-flag',
      'production.floats.cherry:live-flag',
      'staging.base:ghost-flag',
      'staging.base:live-flag',
    ]);
  });

  it('does not treat chrome-extension:// as a JSONC comment', () => {
    const parsed = JSON.parse(
      stripJsonc(`{
      // comment
      "url": "chrome-extension://abc",
      "FEATURE_FLAGS": { "base": { "live-flag": "on" } }
    }`)
    );
    expect(parsed.url).toBe('chrome-extension://abc');
    expect(parsed.FEATURE_FLAGS.base['live-flag']).toBe('on');
  });
});

describe('check-dead-flags: call sites', () => {
  it('finds isFeatureEnabled and getFeatureValue string arguments', () => {
    const hits = findFlagCallSites(`
      if (isFeatureEnabled('live-flag')) return;
      const v = getFeatureValue("other-flag");
    `);
    expect(hits).toEqual([
      { kind: 'isFeatureEnabled', id: 'live-flag', line: 2 },
      { kind: 'getFeatureValue', id: 'other-flag', line: 3 },
    ]);
  });

  it('finds Cherry host flag object keys', () => {
    const hits = findFlagCallSites(`
      mountSlicc({ flags: { 'panel-layouts': 'on', 'ghost': 'on' } });
      applyHostFlagOverrides({ 'agentic-memory': 'on' });
    `);
    expect(hits.map((h) => `${h.kind}:${h.id}`).sort()).toEqual([
      'cherry-host:agentic-memory',
      'cherry-host:ghost',
      'cherry-host:panel-layouts',
    ]);
  });

  it('ignores ids mentioned only in comments', () => {
    expect(
      findFlagCallSites(`
        // isFeatureEnabled('dead-flag')
        /* flags: { 'dead-flag': 'on' } */
        const x = 1;
      `)
    ).toEqual([]);
  });

  it('does not treat comment-stripped strings as code', () => {
    const stripped = stripComments(`const u = 'chrome-extension://x'; // trail`);
    expect(stripped).toContain('chrome-extension://x');
    expect(stripped).not.toContain('trail');
  });
});

describe('check-dead-flags: analyzeFlags', () => {
  const union = [
    { id: 'live-flag', line: 2 },
    { id: 'parked-flag', line: 2 },
  ];
  const registry = [
    {
      id: 'live-flag',
      line: 10,
      defaultValue: 'off',
      since: '2026-09-01',
      floatDefaults: {},
      waiver: null,
    },
    {
      id: 'parked-flag',
      line: 20,
      defaultValue: 'off',
      since: '2026-01-01',
      floatDefaults: {},
      waiver: 'waiting on the host API',
    },
  ];
  const floats = ['standalone', 'cherry'];

  it('fails a declared flag with no consumer', () => {
    const findings = analyzeFlags({
      union: [{ id: 'ghost', line: 1 }],
      registry: [
        {
          id: 'ghost',
          line: 4,
          defaultValue: 'off',
          since: '2026-09-01',
          floatDefaults: {},
          waiver: null,
        },
      ],
      floats,
      callSites: [],
      workerKeys: [],
      wranglerKeys: [],
      now: new Date('2026-09-16T00:00:00Z'),
    });
    expect(findings.filter((f) => f.code === 'dead-flag')).toEqual([
      expect.objectContaining({ code: 'dead-flag', severity: 'error' }),
    ]);
  });

  it('does not fail a waived dead flag', () => {
    const findings = analyzeFlags({
      union,
      registry,
      floats,
      callSites: [{ kind: 'isFeatureEnabled', id: 'live-flag', line: 1, file: 'x.ts' }],
      workerKeys: [],
      wranglerKeys: [],
      now: new Date('2026-09-16T00:00:00Z'),
    });
    expect(findings.filter((f) => f.code === 'dead-flag')).toEqual([]);
  });

  it('fails a consumed id that is not declared', () => {
    const findings = analyzeFlags({
      union,
      registry,
      floats,
      callSites: [
        { kind: 'isFeatureEnabled', id: 'live-flag', line: 1, file: 'x.ts' },
        { kind: 'cherry-host', id: 'not-a-flag', line: 8, file: 'cherry.ts' },
      ],
      workerKeys: [],
      wranglerKeys: [],
      now: new Date('2026-09-16T00:00:00Z'),
    });
    expect(findings.filter((f) => f.code === 'undeclared-flag')).toEqual([
      expect.objectContaining({
        code: 'undeclared-flag',
        file: 'cherry.ts',
        line: 8,
      }),
    ]);
  });

  it('fails a wrangler overlay key that is not in the registry', () => {
    const findings = analyzeFlags({
      union,
      registry,
      floats,
      callSites: [{ kind: 'isFeatureEnabled', id: 'live-flag', line: 1, file: 'x.ts' }],
      workerKeys: [],
      wranglerKeys: [
        {
          id: 'ghost-flag',
          path: 'production.base',
          file: 'packages/cloudflare-worker/wrangler.jsonc',
          line: 12,
        },
      ],
      now: new Date('2026-09-16T00:00:00Z'),
    });
    expect(findings.filter((f) => f.code === 'undeclared-flag')).toEqual([
      expect.objectContaining({ code: 'undeclared-flag', line: 12 }),
    ]);
  });

  it('does not treat a wrangler key as enough to keep a flag alive', () => {
    const findings = analyzeFlags({
      union: [{ id: 'ghost', line: 1 }],
      registry: [
        {
          id: 'ghost',
          line: 4,
          defaultValue: 'off',
          since: '2026-09-01',
          floatDefaults: {},
          waiver: null,
        },
      ],
      floats,
      callSites: [],
      workerKeys: [],
      wranglerKeys: [{ id: 'ghost', path: 'production.base', file: 'wrangler.jsonc', line: 9 }],
      now: new Date('2026-09-16T00:00:00Z'),
    });
    expect(findings.some((f) => f.code === 'dead-flag')).toBe(true);
  });

  it('fails a missing or invalid since', () => {
    const missing = analyzeFlags({
      union: [{ id: 'live-flag', line: 1 }],
      registry: [
        { id: 'live-flag', line: 4, defaultValue: 'off', floatDefaults: {}, waiver: null },
      ],
      floats,
      callSites: [{ kind: 'isFeatureEnabled', id: 'live-flag', line: 1, file: 'x.ts' }],
      workerKeys: [],
      wranglerKeys: [],
    });
    expect(missing.some((f) => f.code === 'missing-since')).toBe(true);

    const invalid = analyzeFlags({
      union: [{ id: 'live-flag', line: 1 }],
      registry: [
        {
          id: 'live-flag',
          line: 4,
          defaultValue: 'off',
          since: '09/2026',
          floatDefaults: {},
          waiver: null,
        },
      ],
      floats,
      callSites: [{ kind: 'isFeatureEnabled', id: 'live-flag', line: 1, file: 'x.ts' }],
      workerKeys: [],
      wranglerKeys: [],
    });
    expect(invalid.some((f) => f.code === 'invalid-since')).toBe(true);
  });

  it('warns when a constant default has been in place for STALE_DAYS', () => {
    const findings = analyzeFlags({
      union: [{ id: 'live-flag', line: 1 }],
      registry: [
        {
          id: 'live-flag',
          line: 4,
          defaultValue: 'on',
          since: '2026-01-01',
          floatDefaults: {},
          waiver: null,
        },
      ],
      floats,
      callSites: [{ kind: 'isFeatureEnabled', id: 'live-flag', line: 1, file: 'x.ts' }],
      workerKeys: [],
      wranglerKeys: [],
      now: new Date('2026-09-16T00:00:00Z'),
    });
    const stale = findings.filter((f) => f.code === 'stale-flag');
    expect(stale).toEqual([expect.objectContaining({ severity: 'warning', code: 'stale-flag' })]);
    expect(daysMention(stale[0].message)).toBeGreaterThanOrEqual(STALE_DAYS);
  });

  it('does not warn when a float carve-out keeps the default from being constant', () => {
    const findings = analyzeFlags({
      union: [{ id: 'live-flag', line: 1 }],
      registry: [
        {
          id: 'live-flag',
          line: 4,
          defaultValue: 'on',
          since: '2026-01-01',
          floatDefaults: { cherry: 'off' },
          waiver: null,
        },
      ],
      floats,
      callSites: [{ kind: 'isFeatureEnabled', id: 'live-flag', line: 1, file: 'x.ts' }],
      workerKeys: [],
      wranglerKeys: [],
      now: new Date('2026-09-16T00:00:00Z'),
    });
    expect(findings.filter((f) => f.code === 'stale-flag')).toEqual([]);
  });

  it('treats a cherry carve-out as not constant across floats', () => {
    expect(
      isConstantAcrossFloats({ defaultValue: 'on', floatDefaults: { cherry: 'off' } }, [
        'standalone',
        'cherry',
      ])
    ).toBe(false);
    expect(
      isConstantAcrossFloats({ defaultValue: 'on', floatDefaults: {} }, ['standalone', 'cherry'])
    ).toBe(true);
  });

  it('rejects impossible calendar dates', () => {
    expect(parseSince('2026-13-01')).toBeNull();
    expect(parseSince('2026-02-30')).toBeNull();
    expect(parseSince('2026-09-16')?.toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });
});

function daysMention(message) {
  const m = /for (\d+) days/.exec(message);
  return m ? Number(m[1]) : 0;
}

describe('check-dead-flags: scratch tree CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'dead-flags-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('fails the CLI when the scratch registry has a dead flag', () => {
    writeScratch(root, {
      registry: `
export type FeatureFlagFloat = 'standalone';
export type FeatureFlagId = 'live-flag' | 'ghost-flag';
const FEATURE_FLAGS = Object.freeze([
  Object.freeze({ id: 'live-flag', defaultValue: 'off', since: '2026-09-01' }),
  Object.freeze({ id: 'ghost-flag', defaultValue: 'off', since: '2026-09-01' }),
]);
`,
      worker: `const FALLBACK_BASE_FLAGS = { 'live-flag': 'on' };`,
      wrangler: `{ "vars": { "FEATURE_FLAGS": { "base": { "live-flag": "on" }, "floats": {} } }, "env": { "staging": { "vars": { "FEATURE_FLAGS": { "base": { "live-flag": "on" }, "floats": {} } } } } }`,
      consumer: `if (isFeatureEnabled('live-flag')) {}`,
    });
    const { code, out } = runGuard(['--root', root, '--now=2026-09-16']);
    expect(code).toBe(1);
    expect(out).toMatch(/dead-flag/);
    expect(out).toMatch(/ghost-flag/);
  });
});

function writeScratch(root, { registry, worker, wrangler, consumer }) {
  const paths = {
    registry: join(root, 'packages/webapp/src/core/feature-flags.ts'),
    worker: join(root, 'packages/cloudflare-worker/src/flags.ts'),
    wrangler: join(root, 'packages/cloudflare-worker/wrangler.jsonc'),
    consumer: join(root, 'packages/webapp/src/ui/gate.ts'),
  };
  for (const abs of Object.values(paths)) mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(paths.registry, registry);
  writeFileSync(paths.worker, worker);
  writeFileSync(paths.wrangler, wrangler);
  writeFileSync(paths.consumer, consumer);
}

describe('check-dead-flags: end-to-end over the real tree', () => {
  it('passes (every registered flag has a consumer) and reports the count', () => {
    const { findings, declared, scanned } = checkRepo(repoRoot, {
      now: new Date('2026-09-16T00:00:00Z'),
    });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(declared).toBeGreaterThanOrEqual(6);
    expect(scanned).toBeGreaterThan(100);

    const { code, out } = runGuard(['--now=2026-09-16']);
    expect(code).toBe(0);
    expect(out).toMatch(/ok: \d+ feature flags, \d+ src files scanned/);
  });
});
