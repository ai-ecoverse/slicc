import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

type CommandContext = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CommandResult = { stdout: string; stderr: string; exitCode: number };

const HELP = `usage: theme <subcommand> [args]

Subcommands:
  list                 List available preset and custom themes
  apply <id>           Apply a preset or custom theme by id
  apply <path>         Apply a theme from a .slicc-theme.json file on the VFS
  reset                Reset to the default theme
  current              Show the currently active theme
  export <id> <path>   Export a theme to a VFS path
`;

export function createThemeCommand(): Command {
  return defineCommand('theme', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return { stdout: HELP, stderr: '', exitCode: 0 };
    }

    const sub = args[0];

    if (sub === 'list') return listThemes();
    if (sub === 'current') return currentTheme();
    if (sub === 'reset') return resetTheme();
    if (sub === 'apply') return applyTheme(args.slice(1), ctx);
    if (sub === 'export') return exportThemeCmd(args.slice(1), ctx);

    return { stdout: '', stderr: `theme: unknown subcommand "${sub}"\n${HELP}`, exitCode: 1 };
  });
}

async function listThemes(): Promise<CommandResult> {
  const { PRESETS } = await import('../../ui/theme-presets.js');
  const { getCustomThemes, getActiveThemeId } = await import('../../ui/theme-engine.js');
  const activeId = getActiveThemeId();
  const lines: string[] = ['Presets:'];
  for (const p of PRESETS) {
    const marker = p.id === activeId ? ' (active)' : '';
    lines.push(`  ${p.id.padEnd(16)} ${p.name}${marker}`);
  }
  const customs = getCustomThemes();
  if (customs.length > 0) {
    lines.push('', 'Custom:');
    for (const t of customs) {
      const marker = t.id === activeId ? ' (active)' : '';
      lines.push(`  ${t.id.padEnd(16)} ${t.name}${marker}`);
    }
  }
  if (!activeId) lines.push('', 'Active: default');
  lines.push('');
  return { stdout: lines.join('\n'), stderr: '', exitCode: 0 };
}

async function currentTheme(): Promise<CommandResult> {
  const { getActiveThemeId } = await import('../../ui/theme-engine.js');
  const id = getActiveThemeId();
  return { stdout: id ? `${id}\n` : 'default\n', stderr: '', exitCode: 0 };
}

async function resetTheme(): Promise<CommandResult> {
  const { clearActiveTheme, applyThemeOverrides } = await import('../../ui/theme-engine.js');
  clearActiveTheme();
  applyThemeOverrides();
  return { stdout: 'Theme reset to default.\n', stderr: '', exitCode: 0 };
}

async function applyTheme(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length === 0) {
    return { stdout: '', stderr: 'theme apply: missing theme id or path\n', exitCode: 1 };
  }

  const target = args[0];
  const { PRESETS } = await import('../../ui/theme-presets.js');
  const { getCustomThemes, setActiveTheme, saveCustomTheme, importTheme, applyThemeOverrides } =
    await import('../../ui/theme-engine.js');

  // Check if it's a preset or custom theme id
  const preset = PRESETS.find((p) => p.id === target);
  const custom = getCustomThemes().find((t) => t.id === target);
  if (preset || custom) {
    setActiveTheme(target);
    applyThemeOverrides();
    return { stdout: `Applied theme: ${(preset || custom)!.name}\n`, stderr: '', exitCode: 0 };
  }

  // Try as a VFS path
  const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
  let content: string;
  try {
    content = await ctx.fs.readFile(fullPath);
  } catch {
    return {
      stdout: '',
      stderr: `theme apply: "${target}" is not a known theme id and file not found at ${fullPath}\n`,
      exitCode: 1,
    };
  }

  let theme;
  try {
    theme = importTheme(content);
  } catch (err) {
    return {
      stdout: '',
      stderr: `theme apply: invalid theme file: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  saveCustomTheme(theme);
  setActiveTheme(theme.id);
  applyThemeOverrides();
  return { stdout: `Applied theme: ${theme.name}\n`, stderr: '', exitCode: 0 };
}

async function exportThemeCmd(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length < 2) {
    return { stdout: '', stderr: 'theme export: usage: theme export <id> <path>\n', exitCode: 1 };
  }

  const [id, path] = args;
  const { PRESETS } = await import('../../ui/theme-presets.js');
  const { getCustomThemes, exportTheme } = await import('../../ui/theme-engine.js');

  const theme = PRESETS.find((p) => p.id === id) ?? getCustomThemes().find((t) => t.id === id);
  if (!theme) {
    return { stdout: '', stderr: `theme export: unknown theme id "${id}"\n`, exitCode: 1 };
  }

  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
  try {
    await ctx.fs.writeFile(fullPath, exportTheme(theme));
  } catch (err) {
    return {
      stdout: '',
      stderr: `theme export: write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  return { stdout: `Exported "${theme.name}" to ${fullPath}\n`, stderr: '', exitCode: 0 };
}
