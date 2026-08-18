import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { LickRegistry } from '../../src/scoops/lick-registry.js';
import { parseLlmsTxtIgnore } from '../../src/scoops/llms-txt-ignore.js';

function discovery(origin = 'https://example.com') {
  return {
    type: 'discovery' as const,
    discoveryOrigin: origin,
    discoveryKind: 'llms-txt' as const,
    discoveryUrl: `${origin}/llms.txt`,
    discoverySource: 'live-navigation' as const,
    timestamp: 't',
    body: {},
  };
}

describe('llms.txt lick dismissal', () => {
  let fs: VirtualFS | null = null;
  afterEach(async () => fs?.dispose?.());

  async function setup() {
    fs = await VirtualFS.create({ dbName: 'lick-registry-discovery', wipe: true });
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile('/etc/llmstxtignore', '# existing\n');
    const persistLickDecision = vi.fn(async () => undefined);
    const registry = new LickRegistry({
      getConeShell: () => null,
      getConeFs: () => fs,
      persistLickDecision,
    });
    return { registry, persistLickDecision };
  }

  it('silently persists the host on dismissal', async () => {
    const { registry, persistLickDecision } = await setup();
    const id = registry.registerDiscovery(discovery());
    expect(id).toBeTruthy();
    await expect(registry.resolve(id!, { decision: 'deny' })).resolves.toMatchObject({
      settled: true,
      persisted: true,
    });
    expect(parseLlmsTxtIgnore(await fs!.readTextFile('/etc/llmstxtignore'))).toContain(
      'example.com'
    );
    expect(persistLickDecision).toHaveBeenCalledWith(id, 'deny');
  });

  it('rejects confirm and ignores non-llms discovery', async () => {
    const { registry } = await setup();
    expect(registry.registerDiscovery({ ...discovery(), discoveryKind: 'ai-catalog' })).toBeNull();
    const id = registry.registerDiscovery(discovery())!;
    await expect(registry.resolve(id, { decision: 'allow' })).resolves.toMatchObject({
      settled: true,
      persisted: false,
    });
  });
});
