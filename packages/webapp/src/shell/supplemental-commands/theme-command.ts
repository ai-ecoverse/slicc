import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest, subcommandHelpText } from './subcommand-help.js';

type CommandContext = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CommandResult = { stdout: string; stderr: string; exitCode: number };

/** Theme owns no value-taking flags; keep the empty list next to isHelpRequest. */
const THEME_VALUE_FLAGS: readonly string[] = [];

const HELP = `usage: theme <subcommand> [args]

Subcommands:
  list                 List available preset and custom themes
  apply <id>           Apply a preset or custom theme by id
  apply <path>         Apply a .slicc-theme.json file from the VFS
  reset                Reset to the default theme
  current              Show the currently active theme
  export <id> <path>   Export a theme to a VFS path
`;

function fail(sub: string, message: string): CommandResult {
  return { stdout: '', stderr: `theme ${sub}: ${message}\n`, exitCode: 1 };
}

export function createThemeCommand(): Command {
  return defineCommand('theme', async (args, ctx) => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { stdout: HELP, stderr: '', exitCode: 0 };
    }

    const sub = args[0];
    // Help before the handler so `theme apply --help` never treats `--help`
    // as a theme id. `theme apply -- --help` still uses the literal path.
    if (isHelpRequest(args.slice(1), { valueFlags: THEME_VALUE_FLAGS })) {
      return {
        stdout: subcommandHelpText('theme', sub, HELP),
        stderr: '',
        exitCode: 0,
      };
    }

    if (sub === 'list') return listThemes(args);
    if (sub === 'current') return currentTheme(args);
    if (sub === 'reset') return resetTheme(args);
    if (sub === 'apply') return applyTheme(args.slice(1), ctx);
    if (sub === 'export') return exportThemeCmd(args.slice(1), ctx);

    return { stdout: '', stderr: `theme: unknown subcommand "${sub}"\n${HELP}`, exitCode: 1 };
  });
}

async function listThemes(args: string[]): Promise<CommandResult> {
  const parsed = parseKnownFlags(args.slice(1), { value: THEME_VALUE_FLAGS });
  if ('error' in parsed) return fail('list', parsed.error);

  // Dynamic import keeps the preset table out of the kernel-worker first-load
  // graph; importing from `base/` (not `ui/`) pays the layer-back-edge debt.
  const { PRESETS } = await import('../../base/theme-presets.js');
  const lines: string[] = ['Presets:'];
  for (const p of PRESETS) {
    lines.push(`  ${p.id.padEnd(16)} ${p.name}`);
  }
  lines.push('');
  return { stdout: lines.join('\n'), stderr: '', exitCode: 0 };
}

async function currentTheme(args: string[]): Promise<CommandResult> {
  const parsed = parseKnownFlags(args.slice(1), { value: THEME_VALUE_FLAGS });
  if ('error' in parsed) return fail('current', parsed.error);

  return {
    stdout: 'Check the Theme settings dialog for the active theme.\n',
    stderr: '',
    exitCode: 0,
  };
}

async function resetTheme(args: string[]): Promise<CommandResult> {
  const parsed = parseKnownFlags(args.slice(1), { value: THEME_VALUE_FLAGS });
  if ('error' in parsed) return fail('reset', parsed.error);

  const panelRpc = getPanelRpcClient();
  if (!panelRpc) {
    return { stdout: '', stderr: 'theme: no panel-RPC connection available\n', exitCode: 1 };
  }
  await panelRpc.call('theme-apply', { action: 'reset' });
  return { stdout: 'Theme reset to default.\n', stderr: '', exitCode: 0 };
}

async function applyTheme(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { value: THEME_VALUE_FLAGS });
  if ('error' in parsed) return fail('apply', parsed.error);

  if (parsed.positionals.length === 0) {
    return { stdout: '', stderr: 'theme apply: missing theme id or path\n', exitCode: 1 };
  }

  const panelRpc = getPanelRpcClient();
  if (!panelRpc) {
    return { stdout: '', stderr: 'theme: no panel-RPC connection available\n', exitCode: 1 };
  }

  const target = parsed.positionals[0];

  const { PRESETS } = await import('../../base/theme-presets.js');
  const preset = PRESETS.find((p) => p.id === target);
  if (preset) {
    const json = JSON.stringify(preset);
    await panelRpc.call('theme-apply', { themeJson: json, action: 'apply' });
    return { stdout: `Applied theme: ${preset.name}\n`, stderr: '', exitCode: 0 };
  }

  // Try as a VFS path
  const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
  let content: string;
  try {
    content = await ctx.fs.readFile(fullPath);
  } catch {
    return {
      stdout: '',
      stderr: `theme apply: "${target}" is not a known preset id and file not found at ${fullPath}\n`,
      exitCode: 1,
    };
  }

  // Validate JSON structure before sending
  try {
    const parsedTheme = JSON.parse(content);
    if (!parsedTheme.id || !parsedTheme.name || !parsedTheme.base || !parsedTheme.tokens) {
      return {
        stdout: '',
        stderr: 'theme apply: invalid theme file (missing id, name, base, or tokens)\n',
        exitCode: 1,
      };
    }
  } catch {
    return { stdout: '', stderr: 'theme apply: file is not valid JSON\n', exitCode: 1 };
  }

  const result = await panelRpc.call('theme-apply', { themeJson: content, action: 'apply' });
  return { stdout: `Applied theme: ${result.applied}\n`, stderr: '', exitCode: 0 };
}

async function exportThemeCmd(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { value: THEME_VALUE_FLAGS });
  if ('error' in parsed) return fail('export', parsed.error);

  if (parsed.positionals.length < 2) {
    return { stdout: '', stderr: 'theme export: usage: theme export <id> <path>\n', exitCode: 1 };
  }

  const [id, path] = parsed.positionals;
  const { PRESETS } = await import('../../base/theme-presets.js');
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) {
    return { stdout: '', stderr: `theme export: unknown preset id "${id}"\n`, exitCode: 1 };
  }

  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
  try {
    await ctx.fs.writeFile(fullPath, JSON.stringify(preset, null, 2));
  } catch (err) {
    return {
      stdout: '',
      stderr: `theme export: write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  return { stdout: `Exported "${preset.name}" to ${fullPath}\n`, stderr: '', exitCode: 0 };
}
