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
      setActiveModelPolicy(emptyModelPolicy());
      log.warn('Failed to read model policy; falling back to own-catalogue-only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
