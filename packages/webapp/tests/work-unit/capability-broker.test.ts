/**
 * The four float-topology adapters against the CapabilityBroker conformance
 * suite (#2276 slice B), plus the composition wiring.
 *
 * Each adapter runs the suite twice: once over a transport that answers
 * everything (so the "allowlisted ops never say unavailable" invariant is
 * exercised against real replies) and once over one that fails every call
 * (so a broken transport still produces typed results, never throws).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_ADAPTERS,
  type CapabilityBroker,
  createCapabilityBrokerForTopology,
  createConnectCapabilityBroker,
  createExtensionCapabilityBroker,
  createRestCapabilityBroker,
  isCapabilityFailure,
  isCapabilityUnavailable,
  type MountDirectoryHandle,
  type PageGestureChannel,
} from '../../src/work-unit/capability/index.js';
import { runCapabilityBrokerConformance } from './capability-broker.conformance.js';
import { scriptedRestFetch, scriptedRestTransports } from './capability-transport-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]): string =>
  readFileSync(join(here, '..', '..', 'src', ...parts), 'utf8');

/** Every op rejects — the "transport is there but broken" half of each pair. */
const brokenRestFetch: typeof fetch = () => Promise.reject(new Error('socket closed'));

runCapabilityBrokerConformance('node-rest (scripted server)', () =>
  createRestCapabilityBroker({ fetchImpl: scriptedRestFetch(), resolveUrl: (p) => p })
);
runCapabilityBrokerConformance('node-rest (transport down)', () =>
  createRestCapabilityBroker({ fetchImpl: brokenRestFetch, resolveUrl: (p) => p })
);
runCapabilityBrokerConformance('extension-direct (scripted service worker)', () =>
  createExtensionCapabilityBroker({ adapter: 'extension-direct', ...scriptedRestTransports() })
);
runCapabilityBrokerConformance('extension-delegate (scripted port)', () =>
  createExtensionCapabilityBroker({ adapter: 'extension-delegate', ...scriptedRestTransports() })
);
runCapabilityBrokerConformance('extension-delegate (transport down)', () =>
  createExtensionCapabilityBroker({
    adapter: 'extension-delegate',
    callSecrets: () => Promise.reject(new Error('port disconnected')),
    callMount: () => Promise.reject(new Error('port disconnected')),
    crossOriginFetch: () => Promise.reject(new Error('port disconnected')),
    requestApproval: () => Promise.reject(new Error('port disconnected')),
  })
);
runCapabilityBrokerConformance('connect (hosted, nothing privileged)', () =>
  createConnectCapabilityBroker()
);
runCapabilityBrokerConformance('connect + page gestures', () =>
  createConnectCapabilityBroker({ pageGestures: stubGestures() })
);

function stubGestures(): PageGestureChannel {
  const handle: MountDirectoryHandle = { id: 'dir-1', name: 'Projects' };
  return {
    pickDirectory: () => Promise.resolve({ ok: true, value: handle }),
    usbRequest: () => Promise.resolve({ ok: true, value: { id: 'u', kind: 'usb' } }),
    serialRequest: () => Promise.resolve({ ok: true, value: { id: 's', kind: 'serial' } }),
    hidRequest: () => Promise.resolve({ ok: true, value: { id: 'h', kind: 'hid' } }),
  };
}

describe('createCapabilityBrokerForTopology', () => {
  it('names an adapter for every float topology, and only those four', () => {
    for (const topology of CAPABILITY_ADAPTERS) {
      expect(createCapabilityBrokerForTopology(topology).adapter).toBe(topology);
    }
    expect([...CAPABILITY_ADAPTERS]).toEqual([
      'node-rest',
      'extension-direct',
      'extension-delegate',
      'connect',
    ]);
  });

  it('matches float-topology.ts one for one', () => {
    const topology = src('shell', 'float-topology.ts');
    const names = /export type FloatTopology =([^;]+);/.exec(topology)?.[1] ?? '';
    const parsed = [...names.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(parsed.sort()).toEqual([...CAPABILITY_ADAPTERS].sort());
  });

  it('layers the injected page-gesture channel onto every topology', async () => {
    for (const topology of CAPABILITY_ADAPTERS) {
      const broker = createCapabilityBrokerForTopology(topology, { pageGestures: stubGestures() });
      expect(broker.mounts.supports('pickDirectory')).toBe(true);
      expect(broker.devices.allowlist).toEqual(['usbRequest', 'serialRequest', 'hidRequest']);
      const picked = await broker.mounts.pickDirectory();
      expect(picked).toEqual({ ok: true, value: { id: 'dir-1', name: 'Projects' } });
    }
  });

  it('leaves gesture ops unavailable when no channel is injected', async () => {
    for (const topology of CAPABILITY_ADAPTERS) {
      const broker = createCapabilityBrokerForTopology(topology);
      expect(broker.mounts.supports('pickDirectory')).toBe(false);
      expect(broker.devices.allowlist).toEqual([]);
      expect(isCapabilityUnavailable(await broker.devices.serialRequest({}))).toBe(true);
    }
  });
});

describe('connect adapter', () => {
  it('reports no privileged capability at all — including localNodeServer', async () => {
    const broker = createConnectCapabilityBroker();
    expect(broker.adapter).toBe('connect');
    for (const domain of ['browser', 'network', 'secrets', 'devices', 'mounts', 'approvals']) {
      expect(
        (broker as unknown as Record<string, CapabilityBroker['network']>)[domain].allowlist
      ).toEqual([]);
    }
    expect(isCapabilityUnavailable(await broker.network.localNodeServer())).toBe(true);
  });
});

describe('browser.* is out of scope for slice B', () => {
  it('stays unavailable on every adapter — it rides the /cdp bridge, not these transports', async () => {
    for (const topology of CAPABILITY_ADAPTERS) {
      const broker = createCapabilityBrokerForTopology(topology);
      expect(broker.browser.allowlist).toEqual([]);
      const shot = await broker.browser.screenshot({ targetId: 't' });
      expect(isCapabilityUnavailable(shot)).toBe(true);
      expect(isCapabilityFailure(shot)).toBe(false);
    }
  });
});

describe('composition-time injection (#2276)', () => {
  it('createKernelHost resolves the topology once, before orchestrator init', () => {
    const host = src('kernel', 'host.ts');
    const resolve = host.indexOf('const topology: CapabilityAdapterId = resolveFloatTopology()');
    const compose = host.indexOf('createCapabilityBrokerForTopology(topology, {');
    const inject = host.indexOf('orchestrator.setCapabilityBroker');
    const boot = host.indexOf('await bootOrchestrator(');
    expect(resolve).toBeGreaterThan(-1);
    expect(compose).toBeGreaterThan(resolve);
    expect(inject).toBeGreaterThan(compose);
    expect(boot).toBeGreaterThan(compose);
  });

  it('shell-and-skills asks the broker for localNodeServer, not float-topology', () => {
    const source = src('scoops', 'scoop-context', 'shell-and-skills.ts');
    expect(source).not.toMatch(/from ['"].*float-topology/);
    expect(source).not.toMatch(/from ['"].*runtime-env/);
    expect(source).toContain('broker.network.localNodeServer');
  });

  it("keeps the adapters' wire code off the boot graph — ops are only ever lazy", () => {
    // `kernel/host.ts` composes a broker before scoops are restored, so the
    // adapter shells are boot-critical. A STATIC import of an ops module
    // would hoist the whole transport (and, for the extension, the bridge
    // clients and sudo brokers underneath it) into the kernel worker's eager
    // closure for a float that may never call a privileged operation. The
    // first-load gate measures the result; this names the cause.
    for (const [file, ops] of [
      ['rest-adapter.ts', 'rest-ops.js'],
      ['extension-adapter.ts', 'extension-ops.js'],
    ]) {
      const source = src('work-unit', 'capability', file);
      const staticImports = [
        ...source.matchAll(/^(?:import|export)(?! type)[\s\S]*?from\s+'([^']+)';$/gm),
      ].map((match) => match[1]);
      expect({ file, staticallyImportsOps: staticImports.includes(`./${ops}`) }).toEqual({
        file,
        staticallyImportsOps: false,
      });
      expect(source).toContain(`import('./${ops}')`);
    }
  });

  it('no adapter imports a float probe — the host is the only place that resolves one', () => {
    for (const file of [
      'rest-adapter.ts',
      'rest-ops.ts',
      'extension-adapter.ts',
      'extension-ops.ts',
      'connect-adapter.ts',
      'compose.ts',
      'for-topology.ts',
      'types.ts',
    ]) {
      const source = src('work-unit', 'capability', file);
      // Imports only: the prose may name a probe while explaining why the
      // adapter does not call one.
      const imports = [...source.matchAll(/^import[\s\S]*?from\s+'[^']+';$/gm)]
        .map((m) => m[0])
        .join('\n');
      expect({
        file,
        probes: /float-topology|isExtensionRealm|isChromeExtensionRealm|runtime-env/.test(imports),
      }).toEqual({ file, probes: false });
    }
  });
});
