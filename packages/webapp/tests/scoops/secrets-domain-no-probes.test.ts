/**
 * #2276 slice C, secrets domain (review-patterns category 10): business
 * logic in `scoops/` never asks "what's my float topology?" to decide how to
 * fetch secrets — it asks the injected `CapabilityBroker`, whose adapter was
 * chosen once at composition time.
 *
 * `scoops/scoop-context/shell-and-skills.ts` used to call
 * `core/secret-env.ts`'s `fetchSecretEnvVars()`, which resolves
 * `resolveSecretTopology()` (a `resolveFloatTopology()` alias) and branches
 * on it internally — the same shape of anti-pattern slice C's network domain
 * removed from `scoops/tray-leader.ts`. It now calls
 * `broker.secrets.listMaskedEnv()` (already implemented by every adapter in
 * slice B) and reuses `buildEnvFromMaskedEntries` — exported from
 * `core/secret-env.ts` so the POSIX-name filter and GitHub-token alias logic
 * are not duplicated — to build the same shell env shape as before.
 *
 * `fetchSecretEnvVars()` itself is UNCHANGED and still used by `ui/wc/wc-
 * live.ts` (`ui/` is not a banned layer) and stays exported for that caller.
 *
 * `shell/supplemental-commands/secret-command.ts` also reads
 * `resolveFloatTopology()` (to pick `inExtension` and the transport backend
 * for its own CRUD surface: `set` / `get` / `peek` / `scope` / `list` /
 * `delete` / `test` / `edit`). That file lives in `shell/`, which OWNS
 * topology per the network-slice precedent (`shell/mcp/redirect-uri.ts`'s
 * callers do the same) — it is not a relocation to fix, and none of its
 * seven operations has a `broker.secrets` equivalent (the broker's allowlist
 * is deliberately smaller than the command's backend — see
 * `work-unit/capability/types.ts`'s `SecretCapability` doc comment), so no
 * new allowlist op is added.
 */

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
  // The ad hoc topology-branching helper this slice removed from `scoops/`
  // — not a generic probe name, but the same class of thing for this
  // domain: business logic deciding its own transport by float.
  'fetchSecretEnvVars',
  // `resolveSecretTopology` (`core/secret-topology.ts`) is a back-compat
  // ALIAS for `resolveFloatTopology` — importing it directly would bypass
  // the literal `resolveFloatTopology` scan while reintroducing the exact
  // branch this slice removed (round-1 review finding 4).
  'resolveSecretTopology',
  // The extension-direct transport this slice's removed branch called
  // directly; a regression that inlines it (rather than importing a named
  // probe) would otherwise slip past every name above.
  'chrome.runtime',
  // The extension-delegate transport `fetchSecretEnvVars()` used — same
  // reasoning: a regression could call this directly from `scoops/` without
  // tripping any of the names above.
  'callSecretsBridge',
] as const;
// `hasLocalNodeServer` is deliberately NOT in this list: it is a local
// `() => localNode.ok` wrapper name in shell-and-skills.ts (matching the
// shell's `webhook.hasLocalNodeServer` option shape from slice B's network
// migration), not an import of a probe function — flagging the identifier
// would be a false positive on code this slice does not touch.

describe('#2276 slice C — scoops/scoop-context/shell-and-skills.ts has no float/topology read', () => {
  it('contains none of the float-probe names, anywhere in the file — not just its imports', () => {
    const source = src('scoops', 'scoop-context', 'shell-and-skills.ts');
    const found = FLOAT_PROBE_NAMES.filter((name) => source.includes(name));
    expect(found).toEqual([]);
  });

  it('gets masked secrets from the injected broker, not a topology-branching helper', () => {
    const source = src('scoops', 'scoop-context', 'shell-and-skills.ts');
    // Pinned on the call, not the `core/secret-env.js` import path: extracting
    // `buildEnvFromMaskedEntries` to its own module later must not fail this
    // guard for an unrelated reason (round-1 review finding 4).
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
