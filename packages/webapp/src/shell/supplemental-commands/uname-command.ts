/**
 * `uname` — uname(1) over SLICC identity.
 *
 * The kernel here is SLICC itself, so `-s` is `SLICC` and `-r` is the running
 * semantic version (`__SLICC_VERSION__`, baked from the root `package.json` —
 * the same value `upgrade`'s lick compares). The browser user agent, which
 * this command used to print bare, moves to `-o`: it describes the operating
 * system SLICC runs *on*, not SLICC.
 */
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { readSliccVersion } from '../../base/slicc-version.js';
import { readTrayRole } from '../../base/tray-role.js';

const KERNEL_NAME = 'SLICC';
const UNKNOWN = 'unknown';
const USAGE = 'usage: uname [-amnorsv]';

/** uname(1) field order for `-a`: kernel name, nodename, release, version, machine, OS. */
const FIELD_ORDER = ['s', 'n', 'r', 'v', 'm', 'o'] as const;
type Field = (typeof FIELD_ORDER)[number];

function unameHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: [
      USAGE,
      '  -s  kernel name (SLICC)',
      '  -n  nodename (tray role: leader, follower, or standalone)',
      '  -r  kernel release (running SLICC version)',
      '  -v  kernel version (build stamp, with release date when known)',
      '  -m  machine (platform this realm reports)',
      '  -o  operating system (browser user agent)',
      '  -a  all of the above, in uname order',
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Build stamp. `buildId` is `<version>-<base36 build time>`; the release date
 * rides alongside when the release pipeline supplied one. No commit sha is
 * baked into the bundle, so none is reported.
 */
function buildVersion(): string {
  const { releasedAt, buildId } = readSliccVersion();
  return releasedAt ? `${buildId} (${releasedAt})` : buildId;
}

function machine(): string {
  const nav = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  const platform = nav?.userAgentData?.platform || nav?.platform;
  return typeof platform === 'string' && platform.length > 0 ? platform : UNKNOWN;
}

function operatingSystem(): string {
  const userAgent = globalThis.navigator?.userAgent;
  return typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : UNKNOWN;
}

function fieldValue(field: Field): string {
  switch (field) {
    case 's':
      return KERNEL_NAME;
    case 'n':
      return readTrayRole();
    case 'r':
      return readSliccVersion().version;
    case 'v':
      return buildVersion();
    case 'm':
      return machine();
    case 'o':
      return operatingSystem();
  }
}

function usageError(message: string): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: '', stderr: `uname: ${message}\n${USAGE}\n`, exitCode: 1 };
}

/**
 * Collect the requested fields. Combined short flags (`uname -sr`) are split
 * per character the way getopt does, and the result is always emitted in
 * uname(1) field order regardless of the order the flags were given.
 */
function selectFields(args: string[]): Set<Field> | { error: string } {
  const selected = new Set<Field>();
  for (const arg of args) {
    if (!arg.startsWith('-') || arg === '-') return { error: `extra operand '${arg}'` };
    if (arg.startsWith('--')) return { error: `unrecognized option '${arg}'` };
    for (const flag of arg.slice(1)) {
      if (flag === 'a') {
        for (const field of FIELD_ORDER) selected.add(field);
        continue;
      }
      if (!(FIELD_ORDER as readonly string[]).includes(flag)) {
        return { error: `unrecognized option '-${flag}'` };
      }
      selected.add(flag as Field);
    }
  }
  return selected;
}

export function createUnameCommand(): Command {
  return defineCommand('uname', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return unameHelp();
    }

    const selected = selectFields(args);
    if ('error' in selected) return usageError(selected.error);

    // Bare `uname` is `uname -s`, as in uname(1).
    const fields: readonly Field[] =
      selected.size > 0 ? FIELD_ORDER.filter((field) => selected.has(field)) : ['s'];

    return {
      stdout: `${fields.map(fieldValue).join(' ')}\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}
