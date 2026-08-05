/** Regression guards for agent-spawn availability in every leader float. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string): string =>
  readFileSync(join(here, '..', '..', 'src', ...path.split('/')), 'utf8');

const liveSource = source('ui/wc/wc-live.ts');
const preludeSource = source('ui/boot/setup-standalone-prelude.ts');
const workerSource = source('kernel/kernel-worker.ts');
const hostSource = source('kernel/host.ts');

describe('kernel AgentBridge topology', () => {
  it('routes the extension leader through the shared kernel-worker boot', () => {
    expect(preludeSource).toContain('extLeader && hasChromeRuntimeConnect()');
    expect(preludeSource).toContain('extensionDelegateId = extLeader.extensionId');
    const prelude = liveSource.indexOf('await setupStandalonePrelude(');
    const spawn = liveSource.indexOf('spawnKernelWorker({');
    expect(prelude).toBeGreaterThan(-1);
    expect(spawn).toBeGreaterThan(prelude);
  });

  it('constructs Bridge and passes it to the shared kernel host', () => {
    const bridge = workerSource.indexOf('const bridge = new Bridge(bridgeTransport)');
    const host = workerSource.indexOf('await createKernelHost({');
    expect(bridge).toBeGreaterThan(-1);
    expect(host).toBeGreaterThan(bridge);
    expect(workerSource.slice(host, host + 500)).toContain('bridge,');
  });

  it('publishes AgentBridge during host boot before returning the host', () => {
    const boot = hostSource.indexOf('await bootOrchestrator(');
    const publish = hostSource.indexOf('publishAgentBridge(orchestrator, sharedFs');
    const ready = hostSource.indexOf('return {', publish);
    expect(boot).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(boot);
    expect(ready).toBeGreaterThan(publish);
  });
});
