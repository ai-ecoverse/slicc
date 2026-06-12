/**
 * SudoFS — filesystem-level sudo enforcement.
 *
 * A transparent decorator around the agent's `VirtualFS`/`RestrictedFS` handle
 * (the single handle shared by the file tools and the shell). Every gated read
 * and write is funneled through one `matchPath` check against the live sudoers
 * policy plus the hardcoded self-protection invariant:
 *
 *   - `require-approval` → ask the {@link SudoBroker}; `deny` → `FsError('EACCES')`,
 *     `allow` → pass through once, `always` → persist a `NOPASSWD` grant to
 *     `/etc/sudoers.d/granted` (broker-mediated, exempt from future prompts).
 *   - `nopasswd-allow` / `no-match` → pass straight through to the wrapped fs.
 *
 * Sync fast-paths (`statSync`/`readDirSync`) cannot await the broker, so a
 * `require-approval` path returns `null` to force the async fallback (which
 * gates), mirroring `RestrictedFS`'s ACL-correct sync behavior.
 */

import { createLogger } from '../core/logger.js';
import {
  matchPath,
  type PathOp,
  pathGlobToRegExp,
  SUDOERS_D_DIR,
  type SudoersPolicy,
  sanitizeGrantPattern,
} from '../shell/sudo/sudoers.js';
import type { SudoBroker, SudoKind } from '../sudo/types.js';
import { normalizePath } from './path-utils.js';
import { FsError } from './types.js';

const log = createLogger('sudo:fs');

/**
 * Marker the sudo-fs `Proxy` advertises through its `get` trap so callers that
 * monkeypatch fs methods *in place* (e.g. the skill-discovery cache-invalidation
 * hooks in `skills/catalog.ts`) can detect this handle and refuse to touch it.
 *
 * The Proxy is get/set-asymmetric: `get` returns a gating override for a gated
 * method, while `set` writes straight through to the wrapped target. Reassigning
 * `fs.writeFile` on it therefore (a) clobbers the target's real method and
 * (b) leaves the override delegating to the freshly-installed wrapper, whose
 * captured `original` (read via `get`) is that same override — an infinite
 * `override → wrapper → override …` recursion that OOMs the kernel worker on the
 * next gated write. A well-known (registry) symbol lets the catalog skip it with
 * no import cycle. See `skills/catalog.ts`.
 */
export const MONKEYPATCH_UNSAFE_FS: unique symbol = Symbol.for('slicc.fs.monkeypatchUnsafe');

/** Drop-in file for persisted "Always" grants. */
export const GRANTED_FILE = `${SUDOERS_D_DIR}/granted`;

/** Async + sync read methods routed through a `read` match. */
const READ_ASYNC = ['readFile', 'readTextFile', 'readDir', 'exists', 'stat'] as const;
/** Async write methods routed through a `write` match. */
const WRITE_ASYNC = ['writeFile', 'mkdir', 'rm'] as const;

/** Dependencies for {@link createSudoFs}. */
export interface SudoFsDeps {
  /** Trusted-realm native approval surface. */
  broker: SudoBroker;
  /** Live policy snapshot, re-read per op so config/granted reloads take effect. */
  getPolicy: () => SudoersPolicy;
  /**
   * Persist + activate a confirmed `NOPASSWD` grant after an "Always" decision.
   * Defaults to {@link defaultApplyGrant}: mutates the live policy and appends
   * the rule to {@link GRANTED_FILE} via the wrapped fs (bypassing the gate).
   */
  onGrant?: (op: PathOp, pattern: string) => void | Promise<void>;
}

/** Minimal surface SudoFS needs for default grant persistence. */
interface PersistTarget {
  readFile(path: string, options?: { encoding?: 'utf-8' | 'binary' }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** Default grant handler: mutate the live policy + append to the granted file. */
async function defaultApplyGrant(
  target: PersistTarget,
  getPolicy: () => SudoersPolicy,
  op: PathOp,
  pattern: string
): Promise<void> {
  const safe = sanitizeGrantPattern(pattern);
  if (!safe) return;
  const policy = getPolicy();
  const rule = { pattern: safe, nopasswd: true, regex: pathGlobToRegExp(safe) };
  (op === 'read' ? policy.read : policy.write).push(rule);

  const directive = op === 'read' ? 'Read' : 'Write';
  const line = `NOPASSWD ${directive} ${safe}\n`;
  try {
    await target.mkdir(SUDOERS_D_DIR, { recursive: true });
    let existing = '';
    try {
      existing = (await target.readFile(GRANTED_FILE, { encoding: 'utf-8' })) as string;
    } catch (err) {
      if (!(err instanceof FsError && err.code === 'ENOENT')) throw err;
    }
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await target.writeFile(GRANTED_FILE, existing + sep + line);
  } catch (err) {
    log.warn('Failed to persist NOPASSWD grant; effective in-session only', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Wrap an FS handle so gated reads/writes require native approval. Returns a
 * `Proxy` that preserves the wrapped type `T` exactly (so it stays a drop-in
 * for `VirtualFS`/`RestrictedFS`), intercepting only the gated methods.
 */
export function createSudoFs<T extends object>(target: T, deps: SudoFsDeps): T {
  const { broker, getPolicy } = deps;
  const applyGrant = deps.onGrant
    ? deps.onGrant
    : (op: PathOp, pattern: string) =>
        defaultApplyGrant(target as unknown as PersistTarget, getPolicy, op, pattern);

  async function gate(op: PathOp, path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (matchPath(getPolicy(), op, normalized) !== 'require-approval') return;
    const kind: SudoKind = op;
    const decision = await broker.requestApproval({ kind, detail: normalized });
    if (decision.decision === 'deny') {
      throw new FsError('EACCES', 'sudo: approval denied', normalized);
    }
    if (decision.decision === 'always') {
      await applyGrant(op, decision.pattern?.trim() || normalized);
    }
  }

  /** Sync fast-path gate: `false` forces async fallback for approval paths. */
  function syncAllowed(path: string): boolean {
    return matchPath(getPolicy(), 'read', normalizePath(path)) !== 'require-approval';
  }

  const has = (prop: string) => typeof (target as Record<string, unknown>)[prop] === 'function';

  const overrides: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of READ_ASYNC) {
    if (has(name)) {
      overrides[name] = async (path: unknown, ...rest: unknown[]) => {
        await gate('read', path as string);
        return (target as Record<string, (...a: unknown[]) => unknown>)[name](path, ...rest);
      };
    }
  }
  for (const name of WRITE_ASYNC) {
    if (has(name)) {
      overrides[name] = async (path: unknown, ...rest: unknown[]) => {
        await gate('write', path as string);
        return (target as Record<string, (...a: unknown[]) => unknown>)[name](path, ...rest);
      };
    }
  }
  if (has('walk')) {
    overrides.walk = async function* (path: unknown, ...rest: unknown[]) {
      await gate('read', path as string);
      yield* (target as Record<string, (...a: unknown[]) => AsyncIterable<unknown>>).walk(
        path,
        ...rest
      );
    };
  }
  if (has('rename')) {
    overrides.rename = async (oldPath: unknown, newPath: unknown) => {
      // A rename exposes the source's contents at the destination, so a
      // read-protected source must clear a read approval before the move —
      // otherwise the policy could be bypassed by relocating then reading.
      await gate('read', oldPath as string);
      await gate('write', oldPath as string);
      await gate('write', newPath as string);
      return (target as Record<string, (...a: unknown[]) => unknown>).rename(oldPath, newPath);
    };
  }
  if (has('copyFile')) {
    overrides.copyFile = async (src: unknown, dest: unknown) => {
      await gate('read', src as string);
      await gate('write', dest as string);
      return (target as Record<string, (...a: unknown[]) => unknown>).copyFile(src, dest);
    };
  }
  if (has('statSync')) {
    overrides.statSync = (path: unknown) =>
      syncAllowed(path as string)
        ? (target as Record<string, (...a: unknown[]) => unknown>).statSync(path)
        : null;
  }
  if (has('readDirSync')) {
    overrides.readDirSync = (path: unknown) =>
      syncAllowed(path as string)
        ? (target as Record<string, (...a: unknown[]) => unknown>).readDirSync(path)
        : null;
  }

  return new Proxy(target, {
    get(obj, prop, receiver) {
      // Advertise the monkeypatch-unsafe marker so in-place fs-method patchers
      // (skill-discovery cache hooks) skip this get/set-asymmetric Proxy instead
      // of installing an infinite override↔wrapper recursion. See the symbol's doc.
      if (prop === MONKEYPATCH_UNSAFE_FS) return true;
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}
