import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import {
  featureFlagIds,
  knownFeatureFlagId,
  mirrorFeatureFlagOverrides,
  resolvedFeatureFlag,
  setLocalFeatureFlag,
} from '../../kernel/feature-flag-local.js';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import { isHelpRequest, subcommandHelpText } from './subcommand-help.js';

type CommandResult = { stdout: string; stderr: string; exitCode: number };

const HELP = `usage: flags set <id> on|off
       flags get <id>

  set <id> on|off    Persist a local override. The next new session reads it.
  get <id>           Print the resolved value
`;

function fail(message: string): CommandResult {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 };
}

function knownLine(): string {
  return `known flags: ${featureFlagIds().join(', ')}\n`;
}

async function persistOverride(
  id: NonNullable<ReturnType<typeof knownFeatureFlagId>>,
  value: 'on' | 'off'
): Promise<void> {
  const rpc = getPanelRpcClient();

  if (rpc && !hasLocalDom()) {
    const { overridesJson } = await rpc.call('feature-flag-set', { id, value });
    mirrorFeatureFlagOverrides(overridesJson);
  } else {
    setLocalFeatureFlag(id, value);
  }
  if (resolvedFeatureFlag(id) !== value) {
    throw new Error(`flag ${id} is ${resolvedFeatureFlag(id) ?? 'unset'} after set`);
  }
}

async function setFlag(args: string[]): Promise<CommandResult> {
  if (args.length !== 2) return fail('usage: flags set <id> on|off');
  const id = knownFeatureFlagId(args[0]);
  if (!id) return fail(`flags: unknown flag ${args[0]}\n${knownLine().trimEnd()}`);
  const value = args[1].toLowerCase();
  if (value !== 'on' && value !== 'off') return fail('flags set: value must be on or off');
  try {
    await persistOverride(id, value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`flags set: ${message}`);
  }
  return { stdout: `${id}=${value}\n`, stderr: '', exitCode: 0 };
}

function getFlag(args: string[]): CommandResult {
  if (args.length !== 1) return fail('usage: flags get <id>');
  const id = knownFeatureFlagId(args[0]);
  if (!id) return fail(`flags: unknown flag ${args[0]}\n${knownLine().trimEnd()}`);
  const value = resolvedFeatureFlag(id);
  if (value === undefined) return fail(`flags: ${id} has no value`);
  return { stdout: `${value}\n`, stderr: '', exitCode: 0 };
}

export function createFlagsCommand(): Command {
  return defineCommand('flags', async (args) => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { stdout: HELP, stderr: '', exitCode: 0 };
    }
    const sub = args[0];
    if (isHelpRequest(args.slice(1))) {
      return { stdout: subcommandHelpText('flags', sub, HELP), stderr: '', exitCode: 0 };
    }
    switch (sub) {
      case 'set':
        return setFlag(args.slice(1));
      case 'get':
        return getFlag(args.slice(1));
      default:
        return fail(`flags: unknown subcommand "${sub}"\n${HELP.trimEnd()}`);
    }
  });
}
