import type { ConeEntry, Registry } from '@slicc/cloud-core';
import { createSubstrate, killCone, startCone } from '@slicc/cloud-core';
import { describe, expect, it } from 'vitest';

const apiKey = process.env['SLICC_TEST_E2B_API_KEY'];
const describeFn = apiKey ? describe : describe.skip;

class MemRegistry implements Registry {
  private entries: ConeEntry[] = [];
  async list() {
    return [...this.entries];
  }
  async findByNameOrId(q: string) {
    return this.entries.find((e) => e.sandboxId === q || e.name === q) ?? null;
  }
  async append(e: ConeEntry) {
    const i = this.entries.findIndex((x) => x.sandboxId === e.sandboxId);
    if (i >= 0) this.entries[i] = { ...this.entries[i]!, ...e };
    else this.entries.push(e);
  }
  async update(id: string, patch: Partial<ConeEntry>) {
    const i = this.entries.findIndex((e) => e.sandboxId === id);
    if (i >= 0) this.entries[i] = { ...this.entries[i]!, ...patch };
  }
  async remove(id: string) {
    this.entries = this.entries.filter((e) => e.sandboxId !== id);
  }
}

describeFn('worker substrate live (requires SLICC_TEST_E2B_API_KEY)', () => {
  it(
    'creates and kills a sandbox via cloud-core ops',
    async () => {
      const substrate = createSubstrate('e2b', { apiKey: apiKey! });
      const registry = new MemRegistry();
      const result = await startCone(
        { substrate, registry },
        {
          envContents: 'ANTHROPIC_API_KEY=sk-fake\nANTHROPIC_API_KEY_DOMAINS=api.anthropic.com',
          envs: {
            ADOBE_IMS_TOKEN: 'fake-bearer',
            ADOBE_IMS_TOKEN_DOMAINS: 'adobe-llm-proxy.example',
          },
          workerBaseUrl: 'https://www.sliccy.ai',
          sliccVersion: 'live-worker-test',
          name: `live-worker-${Date.now()}`,
          pollTimeoutMs: 120_000,
        }
      );
      expect(result.joinUrl).toMatch(/^https:\/\//);
      await killCone({ substrate, registry }, result.sandboxId);
    },
    5 * 60 * 1000
  );
});
