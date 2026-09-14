import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { readSliccVersion } from '../../base/slicc-version.js';
import { readTrayRole } from '../../base/tray-role.js';

const KERNEL_NAME = 'SLICC';
const UNKNOWN = 'unknown';
const USAGE = 'usage: uname [-amnorsv]';

const FIELD_ORDER = ['s', 'n', 'r', 'v', 'm', 'o'] as const;
type Field = (typeof FIELD_ORDER)[number];

function unameHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: [
      USAGE,
      '  -s  kernel name (SLICC)          -n  nodename (leader/follower/standalone)',
      '  -r  release (SLICC version)      -v  build stamp',
      '  -m  machine (realm platform)     -o  operating system (user agent)',
      '  -a  all of the above, in uname order',
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  };
}

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

    const fields: readonly Field[] =
      selected.size > 0 ? FIELD_ORDER.filter((field) => selected.has(field)) : ['s'];

    return {
      stdout: `${fields.map(fieldValue).join(' ')}\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}
