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
  'getExtensionDelegateId',

  'isExtensionRuntime',
  'isThinBridgeWorker',
] as const;

describe('#2276 slice C — sudo/index.ts has no float/topology read', () => {
  it('contains none of the float-probe names, anywhere in the file — not just its imports', () => {
    const source = src('sudo', 'index.ts');
    const found = FLOAT_PROBE_NAMES.filter((name) => source.includes(name));
    expect(found).toEqual([]);
  });

  it('createSudoBroker takes the CapabilityBroker as a required parameter', () => {
    const source = src('sudo', 'index.ts');
    expect(source).toContain(
      'export function createSudoBroker(broker: CapabilityBroker | null): SudoBroker'
    );
  });

  it('wraps approvals.request via capability-gesture-broker.ts, not a topology-specific transport', () => {
    const source = src('sudo', 'index.ts');
    expect(source).toContain("from './capability-gesture-broker.js'");
    expect(source).not.toContain("from './http-broker.js'");
    expect(source).not.toContain("from './extension-broker.js'");
    expect(source).not.toContain("from './panel-rpc-broker.js'");
  });
});

describe('#2276 slice C — sudo/capability-gesture-broker.ts has no float/topology read', () => {
  it('contains none of the float-probe names', () => {
    const source = src('sudo', 'capability-gesture-broker.ts');
    const found = FLOAT_PROBE_NAMES.filter((name) => source.includes(name));
    expect(found).toEqual([]);
  });

  it('calls broker.approvals.request(', () => {
    const source = src('sudo', 'capability-gesture-broker.ts');
    expect(source).toContain('broker.approvals.request(');
  });
});

describe('#2276 slice C — the raw brokers this slice replaced are gone, not just unused', () => {
  it('http-broker.ts / extension-broker.ts / panel-rpc-broker.ts no longer exist', () => {
    for (const file of ['http-broker.ts', 'extension-broker.ts', 'panel-rpc-broker.ts']) {
      expect(() => src('sudo', file)).toThrow();
    }
  });
});

describe('#2276 slice C — SudoManager and the standalone test hook inject the broker, not a module-level fact', () => {
  it('SudoManager takes capabilityBroker as a dep and passes it to createSudoBroker', () => {
    const source = src('sudo', 'sudo-manager.ts');
    expect(source).toContain('capabilityBroker?: CapabilityBroker | null');
    expect(source).toContain('createSudoBroker(deps.capabilityBroker ?? null)');
  });

  it('Orchestrator threads its own composed capabilityBroker into both SudoManager constructions', () => {
    const source = src('scoops', 'orchestrator.ts');
    const occurrences = source.split('capabilityBroker: this.capabilityBroker').length - 1;
    expect(occurrences).toBe(2);
  });

  it('setupSudoStandalone builds a node-rest broker explicitly — standalone IS that topology by definition, not a probe', () => {
    const source = src('ui', 'boot', 'setup-sudo.ts');
    expect(source).toContain('createRestCapabilityBroker');
    expect(source).toContain('createSudoBroker(createRestCapabilityBroker())');
  });
});
