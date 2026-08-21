import llmsTxtIgnoreDefault from '../../../vfs-root/etc/llmstxtignore?raw';
import { createLogger } from '../base/logger.js';
import type { FsWatcher, RestrictedFS, VirtualFS } from '../fs/index.js';
import type { LickEvent } from './lick-manager.js';
import type { RegisteredScoop } from './types.js';

const log = createLogger('llms-txt-ignore');

/** VFS path for persistent llms.txt discovery suppression. */
export const LLMS_TXT_IGNORE_FILE = '/etc/llmstxtignore';

/** Parse hostname/glob entries, stripping `#` comments and blank lines. */
export function parseLlmsTxtIgnore(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.slice(0, line.indexOf('#') === -1 ? undefined : line.indexOf('#')).trim())
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
}

function escapeRegExpChar(ch: string): string {
  return '.+^$()[]|\\{}'.includes(ch) ? `\\${ch}` : ch;
}

function hostnameGlobToRegExp(pattern: string): RegExp {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += escapeRegExpChar(ch);
  }
  return new RegExp(`^${source}$`, 'i');
}

/** True when a hostname matches an exact or glob entry, case-insensitively. */
export function matchesLlmsTxtIgnore(hostname: string, entries: readonly string[]): boolean {
  return entries.some((entry) => hostnameGlobToRegExp(entry).test(hostname));
}

/** True when a scoop can fetch URLs or drive a browser. */
export function scoopCanBrowse(scoop: RegisteredScoop): boolean {
  // A root unit's browsing is gated by the user policy, not by `allowedCommands`.
  if (scoop.parentJid === null) return true;
  const allowed = scoop.config?.allowedCommands;
  if (allowed === undefined || allowed.includes('*')) return true;
  return allowed.some((command) =>
    ['curl', 'wget', 'discover', 'playwright-cli', 'playwright', 'puppeteer'].includes(command)
  );
}

/** Extract the advertising hostname from a discovery origin or artifact URL. */
export function discoveryHostname(origin?: string, artifactUrl?: string): string | null {
  for (const raw of [origin, artifactUrl]) {
    if (!raw) continue;
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      // Try the fallback field.
    }
  }
  return null;
}

/** Append one hostname without duplicating an existing matching rule. */
export async function appendLlmsTxtIgnoreHost(
  fs: VirtualFS | RestrictedFS,
  hostname: string
): Promise<boolean> {
  const normalized = hostname.trim().toLowerCase();
  if (
    !normalized ||
    normalized.includes('\n') ||
    normalized.includes('\r') ||
    normalized.includes('#')
  ) {
    throw new Error('Invalid llms.txt ignore hostname.');
  }
  let existing = '';
  try {
    existing = (await fs.readFile(LLMS_TXT_IGNORE_FILE, { encoding: 'utf-8' })) as string;
  } catch {
    existing = '';
  }
  if (matchesLlmsTxtIgnore(normalized, parseLlmsTxtIgnore(existing))) return false;
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.writeFile(LLMS_TXT_IGNORE_FILE, `${existing}${separator}${normalized}\n`);
  return true;
}

/** Live, watcher-backed policy consulted before a discovery event becomes a lick. */
export class LlmsTxtIgnorePolicy {
  private entries: string[] = [];
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
        (path) => path === LLMS_TXT_IGNORE_FILE,
        () => void this.reload()
      ) ?? null;
  }

  dispose(): void {
    this.unwatch?.();
    this.unwatch = null;
  }

  /** True only for ignored llms.txt events; ai-catalog discovery is unaffected. */
  ignores(event: LickEvent): boolean {
    if (event.type !== 'discovery' || event.discoveryKind !== 'llms-txt') return false;
    const hostname = discoveryHostname(event.discoveryOrigin, event.discoveryUrl);
    return hostname !== null && matchesLlmsTxtIgnore(hostname, this.entries);
  }

  private async ensureDefault(): Promise<void> {
    try {
      await this.fs.mkdir('/etc', { recursive: true });
      if (!(await this.fs.exists(LLMS_TXT_IGNORE_FILE))) {
        await this.fs.writeFile(LLMS_TXT_IGNORE_FILE, llmsTxtIgnoreDefault);
      }
    } catch (err) {
      log.warn('Failed to seed default llms.txt ignore policy', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async reload(): Promise<void> {
    try {
      const raw = await this.fs.readFile(LLMS_TXT_IGNORE_FILE, { encoding: 'utf-8' });
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      this.entries = parseLlmsTxtIgnore(text);
    } catch (err) {
      this.entries = [];
      log.warn('Failed to read llms.txt ignore policy', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
