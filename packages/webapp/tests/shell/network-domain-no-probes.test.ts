import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]): string =>
  readFileSync(join(here, '..', '..', 'src', ...parts), 'utf8');

const FLOAT_PROBE_NAMES = [
  'isExtensionRealm',
  'isChromeExtensionRealm',
  'hasLocalNodeServer',
  'resolveFloatTopology',
  'getChromeExtensionRealm',
  'setChromeExtensionRealm',

  'hasChromeRuntimeConnect',
  'canConnectToChromeRuntime',
] as const;

const FLOAT_PROBE_PATTERN = new RegExp(FLOAT_PROBE_NAMES.join('|'));

describe('#2276 slice C — scoops/tray-leader.ts has no float/topology read at all', () => {
  it('contains none of the float-probe names, anywhere in the file — not just its imports', () => {
    const source = src('scoops', 'tray-leader.ts');
    const found = FLOAT_PROBE_NAMES.filter((name) => source.includes(name));
    expect(found).toEqual([]);
  });

  it('gets its fetch factory from shell/, a downward import', () => {
    const source = src('scoops', 'tray-leader.ts');
    expect(source).toContain("from '../shell/tray-fetch.js'");
  });
});

describe('#2276 slice C — shell/ owns topology and may read the cached fact', () => {
  it('shell/tray-fetch.ts holds the realm branch createTrayFetch needs', () => {
    const source = src('shell', 'tray-fetch.ts');
    expect(source).toContain('getChromeExtensionRealm()');
  });

  it('shell/tray-fetch.ts does not re-export getChromeExtensionRealm under any name', () => {
    const source = src('shell', 'tray-fetch.ts');
    const exportLines = [...source.matchAll(/^export .*$/gm)].map((m) => m[0]);
    expect(exportLines.some((line) => line.includes('getChromeExtensionRealm'))).toBe(false);
  });

  it('shell/proxied-fetch.ts reads the same cached fact for its own extension branch', () => {
    const source = src('shell', 'proxied-fetch.ts');
    expect(source).toContain('getChromeExtensionRealm()');
  });

  it('base/api-endpoint.ts is the one place that imports the live probe, and caches it', () => {
    const source = src('base', 'api-endpoint.ts');
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+'[^']+';$/gm)]
      .map((m) => m[0])
      .join('\n');
    expect(imports).toMatch(/isChromeExtensionRealm/);

    expect(source).toContain('let chromeExtensionRealm: boolean | null = null;');
  });
});

describe('#2276 slice C — redirect-uri.ts takes topology by injection', () => {
  it('resolveMcpRedirectUri takes topology as a parameter, not a return of its own probe', () => {
    const source = src('shell', 'mcp', 'redirect-uri.ts');
    expect(source).toContain('resolveMcpRedirectUri(topology: FloatTopology)');
  });

  it('its two callers resolve topology at their own call site — shell/ owns it, this is not a relocation to fix', () => {
    for (const parts of [
      ['shell', 'mcp', 'provider.ts'],
      ['shell', 'supplemental-commands', 'mcp-command.ts'],
    ] as const) {
      const source = src(...parts);
      expect(source).toContain('resolveMcpRedirectUri(resolveFloatTopology())');
    }
  });
});

describe('#2276 slice C — the guard actually catches the old shape', () => {
  const scan = (source: string) => FLOAT_PROBE_NAMES.filter((name) => source.includes(name));

  it('would fail if tray-leader.ts read the float again (documents the regression this guards against)', () => {
    const regressed = 'const isExtension = getChromeExtensionRealm();\nif (isExtension) {';
    expect(FLOAT_PROBE_PATTERN.test(regressed)).toBe(true);
  });

  it('catches an import of getChromeExtensionRealm from shell/tray-fetch.ts, not only from base/api-endpoint.ts', () => {
    const realSource = src('scoops', 'tray-leader.ts');
    expect(scan(realSource)).toEqual([]);
    const withRegressedImport = `import { getChromeExtensionRealm } from '../shell/tray-fetch.js';\n${realSource}`;
    expect(scan(withRegressedImport)).toEqual(['getChromeExtensionRealm']);
  });
});
