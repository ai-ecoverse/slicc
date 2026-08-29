import { scratchDir } from '../../../shell/tmpdir-env.js';

export interface NodeOs {
  tmpdir(): string;
  homedir(): string;
  platform(): string;
  arch(): string;
  EOL: string;
  cpus(): { model: string; speed: number }[];
  hostname(): string;
  type(): string;
  release(): string;
}

/** Home directory of a shell that pinned no `HOME` — the cone's default. */
export const DEFAULT_HOME = '/home/user';

/**
 * The parts of the `os` shim that do not depend on which unit is running.
 * `process.versions`/`platform`/`arch` in `realm-node-shims.ts` mirror these
 * on purpose, so a script reading both sees one consistent machine.
 */
const STATIC_OS = {
  platform: () => 'linux',
  arch: () => 'x64',
  EOL: '\n',
  cpus: () => [{ model: 'virtual', speed: 0 }],
  hostname: () => 'slicc',
  type: () => 'Linux',
  release: () => '0.0.0',
} as const;

/**
 * Per-realm `os` module, resolved against the realm's own environment.
 *
 * `tmpdir()` and `homedir()` are the two answers that depend on WHO is asking.
 * A scoop's shell pins `HOME=/scoops/<folder>/home` and every unit pins
 * `TMPDIR` (#2267), and `process.env` in the same realm reports both — so
 * returning the float-wide `/tmp` and `/home/user` here made
 * `os.tmpdir() !== process.env.TMPDIR` inside one script. That is precisely
 * the "one consistent machine" invariant `createProcessShim` documents for
 * `platform`/`arch`, and a library that trusts `os.tmpdir()` (most of them do)
 * silently wrote to a directory its own unit did not own.
 *
 * The env is the realm's `init.env`, which `jsh-executor.ts` builds from the
 * shell's own `ctx.env` — so this reads exactly what `process.env` reads,
 * rather than re-deriving the unit's identity through a second path.
 *
 * Both fall back to the pre-#2267 constants: a realm booted with no env is a
 * host with no unit behind it, and those were the right answers for it.
 */
export function createNodeOs(env?: Record<string, string>): NodeOs {
  return {
    ...STATIC_OS,
    tmpdir: () => scratchDir(env),
    homedir: () => env?.['HOME']?.trim() || DEFAULT_HOME,
  };
}

/**
 * Envless `os` module. Retained for hosts that serve the built-in without a
 * realm environment to read; a realm passes its own via {@link createNodeOs}.
 */
export const nodeOs: NodeOs = createNodeOs();
