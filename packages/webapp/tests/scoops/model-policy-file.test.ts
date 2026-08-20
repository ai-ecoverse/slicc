/**
 * `ModelPolicyFile` — seeds `/etc/models` on a fresh VFS, publishes the parsed
 * policy to the providers layer, and live-reloads it on edit (#2195).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsWatcher, VirtualFS } from '../../src/fs/index.js';
import {
  emptyModelPolicy,
  getActiveModelPolicy,
  isModelAllowedByPolicy,
  MODELS_POLICY_FILE,
  setActiveModelPolicy,
} from '../../src/providers/model-policy.js';
import { ModelPolicyFile } from '../../src/scoops/model-policy-file.js';

async function flush(check: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('/etc/models policy file', () => {
  let fs: VirtualFS;
  let watcher: FsWatcher;
  let policyFile: ModelPolicyFile;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `model-policy-${dbCounter++}`, wipe: true });
    watcher = new FsWatcher();
    fs.setWatcher(watcher);
    setActiveModelPolicy(emptyModelPolicy());
    policyFile = new ModelPolicyFile(fs, watcher);
  });

  afterEach(async () => {
    policyFile.dispose();
    setActiveModelPolicy(emptyModelPolicy());
    await fs.dispose?.();
  });

  it('seeds the documented template, which allows nothing extra by default', async () => {
    await policyFile.init();

    const seeded = await fs.readTextFile(MODELS_POLICY_FILE);
    expect(seeded).toContain('which models a scoop may be spawned with');
    // Every example in the template is commented out: own catalogue only.
    expect(getActiveModelPolicy()).toEqual(emptyModelPolicy());
    expect(isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'adobe', 'anything')).toBe(true);
    expect(isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(
      false
    );
  });

  it('does not overwrite an existing policy', async () => {
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile(MODELS_POLICY_FILE, '[adobe]\nopenrouter:*\n');
    await policyFile.init();

    expect(await fs.readTextFile(MODELS_POLICY_FILE)).toBe('[adobe]\nopenrouter:*\n');
    expect(isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(
      true
    );
  });

  it('reloads live when the file changes', async () => {
    await policyFile.init();
    expect(isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(
      false
    );

    await fs.writeFile(MODELS_POLICY_FILE, '[adobe]\nopenrouter:*\n');
    await flush(() =>
      isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'openrouter', 'gpt-5')
    );

    expect(isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(
      true
    );
  });

  it('fails closed when the file becomes unreadable', async () => {
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile(MODELS_POLICY_FILE, '[adobe]\nopenrouter:*\n');
    await policyFile.init();
    expect(isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(
      true
    );

    await fs.rm(MODELS_POLICY_FILE);
    await flush(
      () => !isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'openrouter', 'gpt-5')
    );

    // A deleted/unreadable policy must not keep authorizing another account.
    expect(isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(
      false
    );
    expect(isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'adobe', 'own-model')).toBe(
      true
    );
  });

  it('stops reacting to edits after dispose', async () => {
    await policyFile.init();
    policyFile.dispose();

    await fs.writeFile(MODELS_POLICY_FILE, '[adobe]\nopenrouter:*\n');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(isModelAllowedByPolicy(getActiveModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(
      false
    );
  });
});
