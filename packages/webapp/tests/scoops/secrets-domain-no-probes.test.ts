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
  'resolveFloatTopology',
  'getChromeExtensionRealm',
  'setChromeExtensionRealm',
  'hasChromeRuntimeConnect',
  'canConnectToChromeRuntime',

  'fetchSecretEnvVars',

  'resolveSecretTopology',

  'chrome.runtime',

  'callSecretsBridge',
] as const;

describe('#2276 slice C — scoops/scoop-context/shell-and-skills.ts has no float/topology read', () => {
  it('contains none of the float-probe names, anywhere in the file — not just its imports', () => {
    const source = src('scoops', 'scoop-context', 'shell-and-skills.ts');
    const found = FLOAT_PROBE_NAMES.filter((name) => source.includes(name));
    expect(found).toEqual([]);
  });

  it('gets masked secrets from the injected broker, not a topology-branching helper', () => {
    const source = src('scoops', 'scoop-context', 'shell-and-skills.ts');

    expect(source).toContain('broker.secrets.listMaskedEnv(');
    expect(source).toContain('buildEnvFromMaskedEntries');
  });
});

describe('#2276 slice C — core/secret-env.ts still owns fetchSecretEnvVars for its other caller', () => {
  it('ui/wc/wc-live.ts (ui/, not a banned layer) still calls fetchSecretEnvVars', () => {
    const source = src('ui', 'wc', 'wc-live.ts');
    expect(source).toContain('fetchSecretEnvVars');
  });

  it('exports buildEnvFromMaskedEntries for scoops/ to reuse the same filter/alias logic', () => {
    const source = src('core', 'secret-env.ts');
    expect(source).toContain('export function buildEnvFromMaskedEntries');
  });
});

describe('#2276 slice C — shell/ owns topology for the secret command CRUD surface', () => {
  it('shell/supplemental-commands/secret-command.ts may read resolveFloatTopology — shell/ owns it', () => {
    const source = src('shell', 'supplemental-commands', 'secret-command.ts');
    expect(source).toContain("import { resolveFloatTopology } from '../float-topology.js';");
  });
});
