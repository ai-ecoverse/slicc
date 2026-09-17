import type { CommandContext } from 'just-bash';
import { discoverJshCommands, type JshDiscoveryFS, pathToScanRoots } from '../../jsh-discovery.js';
import type { ScriptCatalog } from '../../script-catalog.js';

export async function resolveUnitScript(
  token: string,
  ctx: CommandContext,
  scriptCatalog?: ScriptCatalog
): Promise<{ path: string } | { error: string }> {
  const resolved = ctx.fs.resolvePath(ctx.cwd, token);
  if (looksLikePath(token) || token.endsWith('.jsh')) {
    if (await ctx.fs.exists(resolved)) return { path: resolved };
    return { error: `cannot find script '${token}'` };
  }
  const found = await lookupSkillCommand(token, ctx, scriptCatalog);
  if (found) return { path: found };
  if (await ctx.fs.exists(resolved)) return { path: resolved };
  return { error: `cannot find script or skill-command '${token}'` };
}

async function lookupSkillCommand(
  name: string,
  ctx: CommandContext,
  scriptCatalog?: ScriptCatalog
): Promise<string | undefined> {
  const pathValue = ctx.env.get('PATH');
  const roots = pathValue === undefined ? undefined : pathToScanRoots(pathValue);
  if (scriptCatalog) return (await scriptCatalog.getJshCommands(roots)).get(name);
  const fs = ctx.fs;
  if (typeof (fs as unknown as JshDiscoveryFS).walk !== 'function') return undefined;
  return (await discoverJshCommands(fs as unknown as JshDiscoveryFS, roots)).get(name);
}

function looksLikePath(token: string): boolean {
  return (
    token.startsWith('/') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.includes('/')
  );
}
