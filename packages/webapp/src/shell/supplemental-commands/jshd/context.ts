/**
 * Kernel-owned CommandContext for jshd units.
 *
 * Restored and restarted units must not inherit the most recent `jshd`
 * caller's filesystem, environment, or missing `exec`. This builds the
 * same canonical shell env the headless shell starts with, plus a real
 * just-bash execution bridge, then overlays the persisted unit env.
 */

import type { CommandContext, IFileSystem } from 'just-bash';
import { createCommandContext } from 'just-bash';
import { DEFAULT_HOME_DIR } from '../../home-dir.js';
import { DEFAULT_SHELL_PATH } from '../../jsh-discovery.js';
import { textAsStdin } from '../../just-bash-compat.js';
import type { JshdUnitRecord } from './types.js';

export interface JshdExecBridge {
  exec: NonNullable<CommandContext['exec']>;
}

export function canonicalJshdEnv(
  record: JshdUnitRecord,
  base?: Record<string, string>
): Map<string, string> {
  return new Map(
    Object.entries({
      HOME: DEFAULT_HOME_DIR,
      PATH: DEFAULT_SHELL_PATH,
      USER: 'user',
      SHELL: '/bin/bash',
      TMPDIR: '/tmp',
      PWD: record.cwd,
      ...base,
      ...record.env,
    })
  );
}

export function createJshdKernelContext(
  fs: IFileSystem,
  record: JshdUnitRecord,
  bridge: JshdExecBridge,
  baseEnv?: Record<string, string>
): CommandContext {
  const env = canonicalJshdEnv(record, baseEnv);
  return createCommandContext({
    fs,
    cwd: record.cwd,
    env,
    stdin: textAsStdin(''),
    exec: (cmd, opts) =>
      bridge.exec(cmd, {
        env: opts?.env ?? Object.fromEntries(env),
        cwd: opts?.cwd ?? record.cwd,
        args: opts?.args,
        ...(opts?.env !== undefined ? { replaceEnv: true } : {}),
      }),
  });
}
