import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readOrCreateSessionId(
  dir: string,
  options: {
    chmod?: (path: string, mode: number) => void;
    platform?: NodeJS.Platform;
    reportError?: (...args: unknown[]) => void;
  } = {}
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'session-id');
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8').trim();
    if (UUID_RE.test(raw)) return raw;
  }
  const fresh = randomUUID();
  writeFileSync(path, fresh + '\n', { encoding: 'utf-8' });
  try {
    (options.chmod ?? chmodSync)(path, 0o600);
  } catch (err) {
    if ((options.platform ?? process.platform) !== 'win32') {
      (options.reportError ?? console.error)(
        `[session-id] chmod 0600 failed at ${path}; session-id may be world-readable`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return fresh;
}
