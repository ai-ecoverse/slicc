import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the session-id from `<dir>/session-id`; if missing/empty/corrupt, generate
 * a fresh UUID, write it (mode 0600), and return that. Idempotent on subsequent calls.
 */
export function readOrCreateSessionId(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'session-id');
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8').trim();
    if (UUID_RE.test(raw)) return raw;
  }
  const fresh = randomUUID();
  writeFileSync(path, fresh + '\n', { encoding: 'utf-8' });
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    // Windows ignores POSIX modes — silent failure is fine.
    // On POSIX, this means the session-id file is world-readable. The
    // session-id is the HMAC key that prevents lookup-table attacks on
    // leaked masks (see docs/architecture.md), so EPERM/EACCES here is
    // a real degradation — surface it.
    if (process.platform !== 'win32') {
      console.error(
        `[session-id] chmod 0600 failed at ${path}; session-id may be world-readable`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return fresh;
}
