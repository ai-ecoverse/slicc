/**
 * Page + Node adapter stubs against the CapabilityBroker conformance suite
 * (#2276), plus the one live page-adapter op (`network.localNodeServer`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createNodeCapabilityBroker,
  createPageCapabilityBroker,
  isCapabilityUnavailable,
} from '../../src/work-unit/capability/index.js';
import { runCapabilityBrokerConformance } from './capability-broker.conformance.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]): string =>
  readFileSync(join(here, '..', '..', 'src', ...parts), 'utf8');

runCapabilityBrokerConformance('page adapter (default, all unavailable)', () =>
  createPageCapabilityBroker()
);
runCapabilityBrokerConformance('page adapter (localNodeServer opted in)', () =>
  createPageCapabilityBroker({ localNodeServer: true })
);
runCapabilityBrokerConformance('node adapter stub', () => createNodeCapabilityBroker());

describe('page adapter localNodeServer', () => {
  it('returns available when the host opts the op in at composition time', async () => {
    const broker = createPageCapabilityBroker({ localNodeServer: true });
    expect(broker.adapter).toBe('page');
    expect(broker.network.supports('localNodeServer')).toBe(true);
    expect(broker.network.allowlist).toEqual(['localNodeServer']);
    const result = await broker.network.localNodeServer();
    expect(result).toEqual({ ok: true, value: { available: true } });
  });

  it('returns CapabilityUnavailable when the host does not opt in', async () => {
    const broker = createPageCapabilityBroker({ localNodeServer: false });
    expect(broker.network.supports('localNodeServer')).toBe(false);
    const result = await broker.network.localNodeServer();
    expect(isCapabilityUnavailable(result)).toBe(true);
    if (isCapabilityUnavailable(result)) {
      expect(result.capability).toBe('network');
      expect(result.operation).toBe('localNodeServer');
    }
  });
});

describe('node adapter stub', () => {
  it('leaves every allowlist empty', () => {
    const broker = createNodeCapabilityBroker();
    expect(broker.adapter).toBe('node');
    expect(broker.browser.allowlist).toEqual([]);
    expect(broker.network.allowlist).toEqual([]);
    expect(broker.secrets.allowlist).toEqual([]);
    expect(broker.devices.allowlist).toEqual([]);
    expect(broker.mounts.allowlist).toEqual([]);
    expect(broker.approvals.allowlist).toEqual([]);
  });
});

describe('composition-time injection (#2276 slice A)', () => {
  it('createKernelHost composes one page broker before orchestrator init', () => {
    const host = src('kernel', 'host.ts');
    const compose = host.indexOf('createPageCapabilityBroker');
    const inject = host.indexOf('orchestrator.setCapabilityBroker');
    const boot = host.indexOf('await bootOrchestrator(');
    expect(compose).toBeGreaterThan(-1);
    expect(inject).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(compose);
  });

  it('shell-and-skills asks the broker for localNodeServer, not float-topology', () => {
    const source = src('scoops', 'scoop-context', 'shell-and-skills.ts');
    expect(source).not.toMatch(/from ['"].*float-topology/);
    expect(source).not.toMatch(/from ['"].*runtime-env/);
    expect(source).toContain('broker.network.localNodeServer');
  });
});
