import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const onNoComment = existsSync(resolve(here, '../../../../.no-comment'));
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

    expect(source).not.toMatch(/import\s*\{[^}]*hasLocalNodeServer/);
  });

  it('the one internal call site passes the already-composed capabilityBroker.adapter', () => {
    const source = src('kernel', 'host.ts');
    expect(source).toContain('shouldStartLickWsBridge(capabilityBroker.adapter)');
  });
});

describe('#2276 slice C — shell/supplemental-commands/crontask-command.ts has no float/topology read', () => {
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

  it.skipIf(onNoComment)('the read carries a one-sentence rationale at the call site', () => {
    const source = src('shell', 'supplemental-commands', 'playwright', 'handlers', 'snapshot.ts');
    expect(source).toContain('#2276: stays a `shell/`-owned realm read, not a CapabilityBroker op');
  });
});
