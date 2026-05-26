import { describe, expect, it } from 'vitest';
import { createSubstrate } from '@slicc/cloud-core';
import { runStart } from '../src/cloud/start.js';
import { runPause } from '../src/cloud/pause.js';
import { runResume } from '../src/cloud/resume.js';
import { runKill } from '../src/cloud/kill.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const apiKey = process.env['SLICC_TEST_E2B_API_KEY'];
const describeFn = apiKey ? describe : describe.skip;

describeFn('cloud live e2e (requires SLICC_TEST_E2B_API_KEY)', () => {
  it(
    'runs the full create → status → pause → resume → kill cycle',
    async () => {
      const substrate = createSubstrate('e2b', { apiKey: apiKey! });
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-live-'));
      const envFile = path.join(dir, 'secrets.env');
      await fs.writeFile(
        envFile,
        'ANTHROPIC_API_KEY=sk-fake\nANTHROPIC_API_KEY_DOMAINS=api.anthropic.com\n'
      );
      const registryPath = path.join(dir, 'cloud-sessions.json');

      const startResult = await runStart({
        substrate,
        envFilePath: envFile,
        registryPath,
        sliccVersion: 'live-test',
        workerBaseUrl: 'https://www.sliccy.ai',
        name: `live-${Date.now()}`,
        pollTimeoutMs: 120_000,
      });
      expect(startResult.joinUrl).toMatch(/^https:\/\//);

      await runPause({ substrate, registryPath, query: startResult.sandboxId });

      const resumeResult = await runResume({
        substrate,
        registryPath,
        query: startResult.sandboxId,
        localSliccVersion: 'live-test',
        pollTimeoutMs: 120_000,
      });
      expect(resumeResult.joinUrl).toMatch(/^https:\/\//);

      await runKill({ substrate, registryPath, query: startResult.sandboxId });
    },
    /* timeout */ 5 * 60 * 1000
  );
});
