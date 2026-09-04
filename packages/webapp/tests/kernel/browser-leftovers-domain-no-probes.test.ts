/**
 * #2276 slice C, final PR — browser + leftovers (review-patterns category
 * 10). This is the last domain PR: after it, `work-unit/capability/index.ts`'s
 * remaining-call-sites inventory is empty except `ui/` and the documented
 * `shell/` topology owners, and slice D (the lint gate) can be built on an
 * empty baseline.
 *
 * Leftovers, each a genuine `kernel/`-layer probe eliminated in favor of a
 * composition-time answer:
 *
 *  - `kernel/telemetry.ts`'s `getModeLabel()` used to call `isExtensionRealm()`
 *    itself. It now takes the caller's `isExtensionRealm` boolean; `ui/main.ts`
 *    passes its own already-resolved `isExtension` local (computed once, at
 *    the top of `main()`, for its own routing) — `ui/` is not on the slice-D
 *    ban list, so that read is fine, it's `kernel/telemetry.ts`'s OWN read
 *    that had to go. `kernel/kernel-worker.ts`'s call never reaches the
 *    extension branch at all (the worker branch short-circuits first), so it
 *    passes nothing and gets the default.
 *  - `kernel/host.ts`'s `shouldStartLickWsBridge()` used to re-probe
 *    `hasLocalNodeServer()` on every call. `bootOrchestrator` already
 *    resolves the float's topology exactly once, into `capabilityBroker`
 *    (`kernel/host.ts` is the one file the slice-D ban exempts); the
 *    function now takes `capabilityBroker.adapter` as a parameter instead of
 *    asking the question a second time.
 *  - `shell/supplemental-commands/crontask-command.ts` had a live,
 *    unwired `hasLocalNodeServer` import — the one genuine migration target
 *    here. It now mirrors `webhook-command.ts`'s established
 *    `WebhookCommandOptions` shape: a `CrontaskCommandOptions` with an
 *    injectable `hasLocalNodeServer`, threaded through
 *    `SupplementalCommandsConfig.crontask` → `HeadlessShellOptions.crontask`
 *    → `shell-and-skills.ts`, reusing the SAME `hasLocalNodeServer` closure
 *    already built there for `webhook`.
 *  - `shell/supplemental-commands/webhook-command.ts` was already fully
 *    compliant — no probe import, already injectable, already wired end to
 *    end. No code change; verified here so the claim has a test, not just a
 *    PR description.
 *
 * Browser: `shell/supplemental-commands/playwright/handlers/snapshot.ts`'s
 * `pdfHandler` keeps its `isExtensionRealm()` read. `shell/` owns topology
 * (`shell/float-topology.ts`'s own header) and there is no `browser.*`
 * CapabilityBroker op to route through — browser automation rides `/cdp` on
 * every adapter, never one of the four broker transports — so inventing one
 * just to satisfy this migration would be a fake adapter op with no real
 * backing. The read only selects an error STRING after the CDP call already
 * failed; verified below alongside the one-sentence rationale comment at the
 * call site.
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
  'hasLocalNodeServer',
  'resolveFloatTopology',
  'getChromeExtensionRealm',
  'setChromeExtensionRealm',
  'hasChromeRuntimeConnect',
  'canConnectToChromeRuntime',
] as const;

describe('#2276 slice C — kernel/telemetry.ts has no float/topology read of its own', () => {
  // `isExtensionRealm` is excluded here too: `getModeLabel`/`initTelemetry`
  // legitimately keep it as a parameter/option NAME (matching the caller's
  // own local of the same name in `ui/main.ts`) — the probe this file must
  // not contain is the IMPORT and CALL, asserted separately below.
  const namesMinusInjectedParam = FLOAT_PROBE_NAMES.filter((n) => n !== 'isExtensionRealm');

  it('contains none of the float-probe names (besides its own injected parameter), anywhere in the file', () => {
    const source = src('kernel', 'telemetry.ts');
    const found = namesMinusInjectedParam.filter((name) => source.includes(name));
    expect(found).toEqual([]);
  });

  it('does not import isExtensionRealm or call it as a function — it is an injected boolean', () => {
    const source = src('kernel', 'telemetry.ts');
    expect(source).not.toMatch(/import\s*\{[^}]*isExtensionRealm/);
    expect(source).not.toContain('isExtensionRealm()');
  });

  it('getModeLabel takes isExtensionRealm as a boolean parameter', () => {
    const source = src('kernel', 'telemetry.ts');
    expect(source).toContain('function getModeLabel(\n  isExtensionRealm: boolean\n)');
  });

  it('initTelemetry accepts an isExtensionRealm option and defaults it closed (non-extension)', () => {
    const source = src('kernel', 'telemetry.ts');
    expect(source).toContain(
      'export async function initTelemetry(opts: { isExtensionRealm?: boolean } = {})'
    );
    expect(source).toContain('getModeLabel(opts.isExtensionRealm ?? false)');
  });
});

describe('#2276 slice C — ui/main.ts passes its own already-resolved realm fact, not a fresh probe', () => {
  it('reuses the isExtension local computed once at the top of main() for initTelemetry too', () => {
    const source = src('ui', 'main.ts');
    // `isExtension` itself is `ui/`'s own read (not banned — `ui/` is outside
    // the slice-D layer list), resolved once and reused for routing AND telemetry.
    expect(source).toContain('const isExtension = isExtensionRealm();');
    expect(source).toContain('initTelemetry({ isExtensionRealm: isExtension })');
  });
});

describe('#2276 slice C — kernel/host.ts shouldStartLickWsBridge takes the resolved topology, not a probe', () => {
  it('takes a CapabilityAdapterId parameter instead of calling hasLocalNodeServer() itself', () => {
    const source = src('kernel', 'host.ts');
    expect(source).toContain(
      "export function shouldStartLickWsBridge(adapter: CapabilityAdapterId): boolean {\n  return adapter === 'node-rest';\n}"
    );
    // The doc comment names `hasLocalNodeServer()` in prose, explaining what
    // this replaced (the network-domain precedent allows that) — the import
    // is what must be gone.
    expect(source).not.toMatch(/import\s*\{[^}]*hasLocalNodeServer/);
  });

  it('the one internal call site passes the already-composed capabilityBroker.adapter', () => {
    const source = src('kernel', 'host.ts');
    expect(source).toContain('shouldStartLickWsBridge(capabilityBroker.adapter)');
  });
});

describe('#2276 slice C — shell/supplemental-commands/crontask-command.ts has no float/topology read', () => {
  // `hasLocalNodeServer` is excluded from this scan on purpose: the file
  // legitimately keeps that NAME as its own injected parameter/property
  // (mirroring `webhook-command.ts`'s established `WebhookCommandOptions`
  // shape below) — the probe it must not contain is the IMPORT from
  // `float-topology.js`, asserted separately.
  const namesMinusInjectedParam = FLOAT_PROBE_NAMES.filter((n) => n !== 'hasLocalNodeServer');

  it('contains none of the float-probe names (besides its own injected parameter), anywhere in the file', () => {
    const source = src('shell', 'supplemental-commands', 'crontask-command.ts');
    const found = namesMinusInjectedParam.filter((name) => source.includes(name));
    expect(found).toEqual([]);
  });

  it('does not import hasLocalNodeServer from float-topology.js — it is now an injected parameter', () => {
    const source = src('shell', 'supplemental-commands', 'crontask-command.ts');
    expect(source).not.toMatch(/import\s*\{[^}]*hasLocalNodeServer/);
    expect(source).not.toContain("from '../float-topology.js'");
  });

  it('createCrontaskCommand takes an injectable hasLocalNodeServer, mirroring WebhookCommandOptions', () => {
    const source = src('shell', 'supplemental-commands', 'crontask-command.ts');
    expect(source).toContain('export interface CrontaskCommandOptions {');
    expect(source).toContain('hasLocalNodeServer?: () => boolean;');
    expect(source).toContain(
      'export function createCrontaskCommand(commandOptions: CrontaskCommandOptions = {}): Command {'
    );
    // Fails CLOSED to the LickManager path (round-1 review on #2841, P1):
    // an unwired caller must not silently assume the privileged node-rest
    // REST path.
    expect(source).toContain('commandOptions.hasLocalNodeServer ?? (() => false)');
  });
});

describe('#2276 slice C — createSupplementalCommands / HeadlessShellOptions thread crontask like webhook', () => {
  it('SupplementalCommandsConfig and its call site pass options.crontask through', () => {
    const source = src('shell', 'supplemental-commands', 'index.ts');
    expect(source).toContain('crontask?: CrontaskCommandOptions;');
    expect(source).toContain('createCrontaskCommand(options.crontask)');
  });

  it('HeadlessShellOptions and its call site pass options.crontask through', () => {
    const source = src('shell', 'almost-bash-shell-headless.ts');
    expect(source).toContain("crontask?: SupplementalCommandsConfig['crontask'];");
    expect(source).toContain('crontask: options.crontask,');
  });

  it('shell-and-skills.ts reuses the SAME hasLocalNodeServer closure it already built for webhook', () => {
    const source = src('scoops', 'scoop-context', 'shell-and-skills.ts');
    expect(source).toContain('crontask: { hasLocalNodeServer },');
  });
});

describe('#2276 round-1 review on #2841 (P1) — kernel/panel-terminal-host.ts has no float/topology read', () => {
  // The one production human-typed shell (the panel terminal) was missed in
  // the original browser+leftovers pass: it had a live `hasLocalNodeServer`
  // import as a webhook fallback, AND never threaded `crontask` at all — so
  // after crontask-command.ts stopped defaulting to a raw probe, the panel
  // terminal's `crontask create` silently assumed node-rest on every float
  // (Grok's repro: a 404 fetch on extension-delegate where the LickManager
  // should have been used instead).
  it('contains none of the float-probe names (besides its own injected parameter names)', () => {
    const source = src('kernel', 'panel-terminal-host.ts');
    const found = FLOAT_PROBE_NAMES.filter((n) => n !== 'hasLocalNodeServer').filter((name) =>
      source.includes(name)
    );
    expect(found).toEqual([]);
  });

  it('does not import hasLocalNodeServer from core/float-topology.js — it is an injected parameter', () => {
    const source = src('kernel', 'panel-terminal-host.ts');
    expect(source).not.toMatch(/import\s*\{[^}]*hasLocalNodeServer/);
    expect(source).not.toContain("from '../core/float-topology.js'");
  });

  it('threads crontask through to PanelTerminalShell, mirroring webhook', () => {
    const source = src('kernel', 'panel-terminal-host.ts');
    expect(source).toContain("crontask?: HeadlessShellOptions['crontask'];");
    expect(source).toContain('crontask: options.crontask,');
  });

  it('kernel-worker.ts supplies BOTH webhook and crontask from the one resolved capabilityBroker.adapter', () => {
    const source = src('kernel', 'kernel-worker.ts');
    expect(source).toContain(
      "const hasLocalNodeServer = () => deps.host.capabilityBroker.adapter === 'node-rest';"
    );
    expect(source).toContain('webhook: { hasLocalNodeServer },');
    expect(source).toContain('crontask: { hasLocalNodeServer },');
  });

  it("the factory's own webhook default fails CLOSED, same as crontask's — production is unreachable (kernel-worker always injects) but an unwired caller must not assume node-rest", () => {
    const source = src('kernel', 'panel-terminal-host.ts');
    expect(source).toContain(
      'hasLocalNodeServer: options.webhook?.hasLocalNodeServer ?? (() => false),'
    );
  });
});

describe('#2276 slice C — webhook-command.ts was already compliant, no code change needed', () => {
  it('contains none of the float-probe names (besides its own injected hasLocalNodeServer parameter)', () => {
    const source = src('shell', 'supplemental-commands', 'webhook-command.ts');
    const found = FLOAT_PROBE_NAMES.filter((n) => n !== 'hasLocalNodeServer').filter((name) =>
      source.includes(name)
    );
    expect(found).toEqual([]);
  });

  it('does not import hasLocalNodeServer from float-topology.js — it is an injected parameter', () => {
    const source = src('shell', 'supplemental-commands', 'webhook-command.ts');
    expect(source).not.toMatch(/import\s*\{[^}]*hasLocalNodeServer/);
    expect(source).not.toContain("from '../float-topology.js'");
  });

  it('already takes an injectable hasLocalNodeServer via WebhookCommandOptions', () => {
    const source = src('shell', 'supplemental-commands', 'webhook-command.ts');
    expect(source).toContain('hasLocalNodeServer?: () => boolean;');
  });
});

describe('#2276 slice C — browser: snapshot.ts keeps its shell-owned realm read, documented', () => {
  it('pdfHandler still reads isExtensionRealm() — shell/ owns topology, no browser.* broker op exists', () => {
    const source = src('shell', 'supplemental-commands', 'playwright', 'handlers', 'snapshot.ts');
    expect(source).toContain('isExtensionRealm()');
  });

  it('the read carries a one-sentence rationale at the call site', () => {
    const source = src('shell', 'supplemental-commands', 'playwright', 'handlers', 'snapshot.ts');
    expect(source).toContain('#2276: stays a `shell/`-owned realm read, not a CapabilityBroker op');
  });
});
