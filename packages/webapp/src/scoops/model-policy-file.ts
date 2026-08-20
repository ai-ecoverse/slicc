/**
 * Loads `/etc/models` from the VFS and publishes it to the providers layer.
 *
 * The policy itself (parsing, evaluation, the live snapshot) lives in
 * `providers/model-policy.ts`; only the file half is here, because the
 * synchronous model resolvers cannot await a VFS read. Same shape as
 * {@link import('./llms-txt-ignore.js').LlmsTxtIgnorePolicy}: seed the shipped
 * template on a fresh VFS, load, then watch for live reload.
 */

import modelsPolicyDefault from '../../../vfs-root/etc/models?raw';
import { createLogger } from '../base/logger.js';
import type { FsWatcher, VirtualFS } from '../fs/index.js';
import {
  emptyModelPolicy,
  MODELS_POLICY_FILE,
  parseModelPolicy,
  setActiveModelPolicy,
} from '../providers/model-policy.js';

const log = createLogger('model-policy-file');

/** Live, watcher-backed `/etc/models` loader. */
export class ModelPolicyFile {
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly fs: VirtualFS,
    private readonly watcher: FsWatcher | null = null
  ) {}

  async init(): Promise<void> {
    await this.ensureDefault();
    await this.reload();
    this.unwatch =
      this.watcher?.watch(
        '/etc',
        (path) => path === MODELS_POLICY_FILE,
        () => void this.reload()
      ) ?? null;
  }

  dispose(): void {
    this.unwatch?.();
    this.unwatch = null;
  }

  private async ensureDefault(): Promise<void> {
    try {
      await this.fs.mkdir('/etc', { recursive: true });
      if (!(await this.fs.exists(MODELS_POLICY_FILE))) {
        await this.fs.writeFile(MODELS_POLICY_FILE, modelsPolicyDefault);
        log.info('Seeded default /etc/models policy');
      }
    } catch (err) {
      log.warn('Failed to seed default model policy', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async reload(): Promise<void> {
    try {
      const raw = await this.fs.readFile(MODELS_POLICY_FILE, { encoding: 'utf-8' });
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      setActiveModelPolicy(parseModelPolicy(text));
    } catch (err) {
      // Fail CLOSED: an unreadable policy leaves the selected provider's own
      // catalogue usable and every other account off-limits, rather than
      // inheriting whatever was parsed before the file broke.
      setActiveModelPolicy(emptyModelPolicy());
      log.warn('Failed to read model policy; falling back to own-catalogue-only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
