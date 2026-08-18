import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { LickRegistry } from '../../src/scoops/lick-registry.js';
import { parseLlmsTxtIgnore } from '../../src/scoops/llms-txt-ignore.js';
import { parseSudoers } from '../../src/shell/sudo/sudoers.js';
import type { SudoBroker } from '../../src/sudo/index.js';

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

  async function setup(decision: 'allow' | 'deny') {
    fs = await VirtualFS.create({ dbName: `lick-registry-discovery-${decision}`, wipe: true });
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile('/etc/llmstxtignore', '# existing\n');
    const requestApproval = vi.fn(async () => ({ decision }) as const);
    const persistLickDecision = vi.fn(async () => undefined);
    const broker: SudoBroker = { requestApproval };
    const registry = new LickRegistry({
      getConeShell: () => null,
      getConeFs: () => fs,
      getSudoManager: () =>
        ({ getBroker: () => broker, getPolicy: () => parseSudoers('') }) as never,
      persistLickDecision,
    });
    return { registry, requestApproval, persistLickDecision };
  }

  it('persists the host through an approved sudo write', async () => {
    const { registry, requestApproval, persistLickDecision } = await setup('allow');
    const id = registry.registerDiscovery(discovery());
    expect(id).toBeTruthy();
    await expect(registry.resolve(id!, { decision: 'deny' })).resolves.toMatchObject({
      settled: true,
      persisted: true,
    });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'write', detail: '/etc/llmstxtignore' })
    );
    expect(parseLlmsTxtIgnore(await fs!.readTextFile('/etc/llmstxtignore'))).toContain(
      'example.com'
    );
    expect(persistLickDecision).toHaveBeenCalledWith(id, 'deny');
  });

  it('leaves the card unsettled when the sudo prompt is denied', async () => {
    const { registry, persistLickDecision } = await setup('deny');
    const id = registry.registerDiscovery(discovery());
    await expect(registry.resolve(id!, { decision: 'deny' })).rejects.toMatchObject({
      code: 'EACCES',
    });
    expect(parseLlmsTxtIgnore(await fs!.readTextFile('/etc/llmstxtignore'))).toEqual([]);
    expect(persistLickDecision).not.toHaveBeenCalled();
  });

  it('rejects confirm and ignores non-llms discovery', async () => {
    const { registry } = await setup('allow');
    expect(registry.registerDiscovery({ ...discovery(), discoveryKind: 'ai-catalog' })).toBeNull();
    const id = registry.registerDiscovery(discovery())!;
    await expect(registry.resolve(id, { decision: 'allow' })).resolves.toMatchObject({
      settled: true,
      persisted: false,
    });
  });
});
