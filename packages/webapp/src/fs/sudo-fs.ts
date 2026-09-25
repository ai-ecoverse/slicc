import { createLogger } from '../base/logger.js';
import {
  applyDefaultDisposition,
  type DefaultDisposition,
  matchPath,
  type PathOp,
  pathGlobToRegExp,
  SUDOERS_D_DIR,
  type SudoersPolicy,
  sanitizeGrantPattern,
} from '../base/sudoers.js';
import { sudoRefusalMessage } from '../sudo/approval-timeout.js';
import type { SudoBroker, SudoDecision, SudoKind } from '../sudo/types.js';
import { normalizePath } from './path-utils.js';
import { FsError } from './types.js';

const log = createLogger('sudo:fs');

export const MONKEYPATCH_UNSAFE_FS: unique symbol = Symbol.for('slicc.fs.monkeypatchUnsafe');

type FsMethodBag = Record<string, (...a: unknown[]) => unknown>;

export const GRANTED_FILE = `${SUDOERS_D_DIR}/granted`;

export const FS_DENIED_MESSAGE = 'sudo: approval denied';

export const FS_UNHONORED_SUDOERS_MESSAGE =
  'sudo: refusing to write a sudoers file outside /etc — policy is read only from /etc/sudoers and /etc/sudoers.d/, so this file would never take effect';

export function fsSudoMessage(decision: SudoDecision): string {
  return sudoRefusalMessage('sudo', decision);
}

const READ_ASYNC = [
  'readFile',
  'readFileRange',
  'getNativeFile',
  'readTextFile',
  'readDir',
  'exists',
  'stat',
] as const;

const CONTENT_WRITE_ASYNC = ['writeFile', 'appendFile'] as const;

const STRUCTURAL_WRITE_ASYNC = ['mkdir', 'rm', 'chmod', 'utimes'] as const;

export interface SudoFsDeps {
  broker: SudoBroker;

  getPolicy: () => SudoersPolicy;

  onGrant?: (op: PathOp, pattern: string) => void | Promise<void>;

  defaultDisposition?: DefaultDisposition;
}

interface PersistTarget {
  readFile(path: string, options?: { encoding?: 'utf-8' | 'binary' }): Promise<string | Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

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

export function createSudoFs<T extends object>(target: T, deps: SudoFsDeps): T {
  const { broker, getPolicy } = deps;
  const defaultDisposition: DefaultDisposition = deps.defaultDisposition ?? 'allow';
  const applyGrant = deps.onGrant
    ? deps.onGrant
    : (op: PathOp, pattern: string) =>
        defaultApplyGrant(target as unknown as PersistTarget, getPolicy, op, pattern);

  async function gate(op: PathOp, path: string, isContentWrite = false): Promise<void> {
    const normalized = normalizePath(path);
    const raw = matchPath(getPolicy(), op, normalized, { isContentWrite });

    const result = op === 'write' ? applyDefaultDisposition(raw, defaultDisposition) : raw;

    if (result === 'deny') {
      log.warn('Refusing write to an unhonoured sudoers path', { path: normalized });
      throw new FsError('EACCES', FS_UNHONORED_SUDOERS_MESSAGE, normalized);
    }
    if (result !== 'require-approval') return;
    const kind: SudoKind = op;
    const decision = await broker.requestApproval({ kind, detail: normalized });
    if (decision.decision === 'deny') {
      throw new FsError('EACCES', fsSudoMessage(decision), normalized);
    }
    if (decision.decision === 'always') {
      await applyGrant(op, decision.pattern?.trim() || normalized);
    }
  }

  function syncAllowed(path: string): boolean {
    return matchPath(getPolicy(), 'read', normalizePath(path)) !== 'require-approval';
  }

  const has = (prop: string) => typeof (target as Partial<FsMethodBag>)[prop] === 'function';

  const overrides: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of READ_ASYNC) {
    if (has(name)) {
      overrides[name] = async (path: unknown, ...rest: unknown[]) => {
        await gate('read', path as string);
        return (target as FsMethodBag)[name](path, ...rest);
      };
    }
  }
  for (const name of CONTENT_WRITE_ASYNC) {
    if (has(name)) {
      overrides[name] = async (path: unknown, ...rest: unknown[]) => {
        await gate('write', path as string, true);
        return (target as FsMethodBag)[name](path, ...rest);
      };
    }
  }
  for (const name of STRUCTURAL_WRITE_ASYNC) {
    if (has(name)) {
      overrides[name] = async (path: unknown, ...rest: unknown[]) => {
        await gate('write', path as string);
        return (target as FsMethodBag)[name](path, ...rest);
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
  if (has('symlink')) {
    overrides.symlink = async (linkTarget: unknown, linkPath: unknown) => {
      await gate('write', linkPath as string);
      return (target as FsMethodBag).symlink(linkTarget, linkPath);
    };
  }
  if (has('rename')) {
    overrides.rename = async (oldPath: unknown, newPath: unknown) => {
      await gate('read', oldPath as string);
      await gate('write', oldPath as string);
      await gate('write', newPath as string);
      return (target as FsMethodBag).rename(oldPath, newPath);
    };
  }
  if (has('copyFile')) {
    overrides.copyFile = async (src: unknown, dest: unknown) => {
      await gate('read', src as string);
      await gate('write', dest as string);
      return (target as FsMethodBag).copyFile(src, dest);
    };
  }
  if (has('updateMetadataBatch')) {
    overrides.updateMetadataBatch = async (updates: unknown) => {
      const list = updates as ReadonlyArray<{ path: string }>;
      for (const update of list) {
        await gate('write', update.path);
      }
      return (target as FsMethodBag).updateMetadataBatch(updates);
    };
  }
  if (has('mount')) {
    overrides.mount = async (path: unknown, ...rest: unknown[]) => {
      await gate('write', path as string);
      return (target as FsMethodBag).mount(path, ...rest);
    };
  }
  if (has('unmount')) {
    overrides.unmount = async (path: unknown) => {
      await gate('write', path as string);
      return (target as FsMethodBag).unmount(path);
    };
  }
  if (has('refreshMount')) {
    overrides.refreshMount = async (path: unknown, ...rest: unknown[]) => {
      await gate('write', path as string);
      return (target as FsMethodBag).refreshMount(path, ...rest);
    };
  }
  if (has('statSync')) {
    overrides.statSync = (path: unknown) =>
      syncAllowed(path as string) ? (target as FsMethodBag).statSync(path) : null;
  }
  if (has('readDirSync')) {
    overrides.readDirSync = (path: unknown) =>
      syncAllowed(path as string) ? (target as FsMethodBag).readDirSync(path) : null;
  }

  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === MONKEYPATCH_UNSAFE_FS) return true;
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}
