// @vitest-environment jsdom
/**
 * The exporter page's stores (slicc#4051), opened without a kernel: six's
 * `slicc-fs` VFS and `slicc-groups` units are read directly, legacy unit
 * records get their parent edge as the kernel would give it, the page never
 * writes into six, and `slicc_accounts` secrets are still redacted.
 */
import 'fake-indexeddb/auto';
import { validateSliccProfileManifest } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { saveScoop } from '../../src/scoops/db.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { planProfileDirectory } from '../../src/transcript/profile-export.js';
import {
  createUpgradeExportDeps,
  FRAME_KNOWN_SECRETS,
  openUpgradeExportDeps,
  restoredUnits,
  SIX_KERNEL_FS_DB_NAME,
} from '../../src/ui/upgrade-to-seven/exporter-deps.js';

const scoop = (fields: Partial<RegisteredScoop>): RegisteredScoop =>
  ({ jid: 'x', name: 'x', folder: 'x', ...fields }) as RegisteredScoop;

describe('restoredUnits', () => {
  it("backfills a legacy record's parent the way the kernel does, without writing", () => {
    const legacyCone = scoop({ jid: 'cone_1', folder: 'cone', isCone: true } as never);
    const legacyScoop = scoop({ jid: 's1', folder: 's1' });
    const modern = scoop({ jid: 's2', folder: 's2', parentJid: 'cone_1' });
    const units = restoredUnits([legacyCone, legacyScoop, modern]);
    expect(units.map((u) => u.parentJid)).toEqual([null, 'cone_1', 'cone_1']);
    expect(legacyScoop.parentJid).toBeUndefined();
  });
});

describe('createUpgradeExportDeps', () => {
  it('reports no secret stores and lets known secrets through to the literal layer', async () => {
    const deps = createUpgradeExportDeps({
      vfs: (await VirtualFS.create({ dbName: 'exporter-deps-a', wipe: true })) as never,
      units: [],
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [],
      readSnapshot: async () => null as never,
      version: '6.0.0-test',
    });
    expect(await deps.storedSecretKinds()).toEqual([]);
    expect(await FRAME_KNOWN_SECRETS.redact(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('never writes a transcript snapshot into six', async () => {
    let captured: { snapshotStore: { write(): Promise<void> } } | null = null;
    const deps = createUpgradeExportDeps({
      vfs: (await VirtualFS.create({ dbName: 'exporter-deps-b', wipe: true })) as never,
      units: [],
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [],
      readSnapshot: async () => null as never,
      version: '6.0.0-test',
    });
    const source = deps.createTranscriptSource(FRAME_KNOWN_SECRETS) as unknown as {
      deps: typeof captured;
    };
    captured = source.deps;
    await expect(captured!.snapshotStore.write()).rejects.toThrow(/never writes/);
  });
});

describe('openUpgradeExportDeps', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("plans a valid directory from six's own stores, redacting slicc_accounts keys", async () => {
    const key = 'zzfake-anthropic-key-0123456789abcdef';
    const accounts = JSON.stringify([{ providerId: 'anthropic', apiKey: key }]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'slicc_accounts' ? accounts : null),
    });
    const fs = await VirtualFS.create({ dbName: SIX_KERNEL_FS_DB_NAME, wipe: true });
    await fs.mkdir('/workspace/docs', { recursive: true });
    await fs.writeFile('/workspace/docs/plain.md', 'plain\n');
    await fs.writeFile('/workspace/docs/keyed.md', `key ${key}\n`);
    await saveScoop(scoop({ jid: 'cone_1', name: 'Sliccy', folder: 'cone', parentJid: null }));

    const deps = await openUpgradeExportDeps('6.0.0-test');
    const plan = await planProfileDirectory(deps);
    expect(validateSliccProfileManifest(plan.manifest)).toEqual({ ok: true });
    expect(plan.manifest.cones.map((c) => c.folder)).toEqual(['cone']);
    expect(plan.manifest.providers).toEqual(['anthropic']);
    const plain = plan.manifest.files.find((f) => f.path === 'files/cones/cone/docs/plain.md');
    const keyed = plan.manifest.files.find((f) => f.path === 'files/cones/cone/docs/keyed.md');
    expect(plain?.source).toBe('/slicc-fs/workspace/docs/plain.md');
    expect(keyed?.source).toBeUndefined();
  });
});
