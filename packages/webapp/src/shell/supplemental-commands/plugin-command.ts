/**
 * `plugin` supplemental command — load Agent Plugins packages
 * (agent-plugins.org spec v1.0.0).
 *
 * Subcommands:
 *   install <path>       Validate a plugin directory and register it.
 *   list                 Table of installed plugins.
 *   info <name>          Manifest, skills, and MCP servers of one plugin.
 *   validate <path>      Dry-run: load + report diagnostics, install nothing.
 *   remove <name>        Unregister a plugin and its MCP servers.
 *
 * The loader (`../plugins/loader.ts`) implements the spec's validation and
 * failure-isolation rules; this file orchestrates persistence and CLI
 * ergonomics. Installed skills surface through the standard skills discovery
 * (`skills/catalog.ts` reads the same registry). Supported `streamable-http`
 * MCP servers are bridged into the existing `/workspace/.mcp/servers.json`
 * store under the name `<plugin>:<server>`.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../core/logger.js';
import type { VirtualFS } from '../../fs/index.js';
import type { LoadedPlugin, PluginDiagnostic } from '../plugins/types.js';

const log = createLogger('plugin-command');

/** Injection hooks — production code uses defaults, tests pass stubs. */
export interface PluginCommandDeps {
  /** Shared shell `VirtualFS` (falls back to the global instance). */
  fs?: VirtualFS;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function err(message: string, code = 1): ExecResult {
  return { stdout: '', stderr: `${message}\n`, exitCode: code };
}

function helpText(): string {
  return `usage: plugin <command> [args]

Load Agent Plugins packages (agent-plugins.org spec v1.0.0): portable
directories bundling Agent Skills (skills/*/SKILL.md) and MCP servers
(mcp.json) behind a plugin.json manifest.

Commands:
  install <path>      Validate the plugin at <path> and register it.
                      Skills surface through the standard skills discovery;
                      streamable-http MCP servers are added to the MCP store
                      as "<plugin>:<server>".
  list                List installed plugins.
  info <name>         Show manifest, skills, and MCP servers of a plugin.
  validate <path>     Load + report conformance diagnostics without
                      installing anything.
  remove <name>       Unregister a plugin and its bridged MCP servers.

Transport support: streamable-http only. stdio entries are skipped (no
subprocesses in the browser) and legacy sse entries are skipped, per the
spec's single-transport allowance — other components still load.

Examples:
  plugin install /workspace/my-plugin
  plugin list
  plugin info my-plugin
  plugin remove my-plugin
`;
}

export function createPluginCommand(deps: PluginCommandDeps = {}): Command {
  return defineCommand('plugin', async (args, ctx): Promise<ExecResult> => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return ok(helpText());
    }
    const sub = args[0];
    const rest = args.slice(1);
    const cwd = ctx?.cwd ?? '/';
    try {
      switch (sub) {
        case 'install':
        case 'add':
          return await cmdInstall(rest, cwd, deps);
        case 'list':
        case 'ls':
          return await cmdList(rest, deps);
        case 'info':
          return await cmdInfo(rest, deps);
        case 'validate':
          return await cmdValidate(rest, cwd, deps);
        case 'remove':
        case 'rm':
        case 'delete':
          return await cmdRemove(rest, deps);
        default:
          return err(`plugin: unknown subcommand "${sub}" (try \`plugin --help\`)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('plugin subcommand failed', { sub, error: msg });
      return err(`plugin ${sub}: ${msg}`);
    }
  });
}

/** Resolve the VFS used for reading plugin packages and the registries. */
async function openVfs(deps: PluginCommandDeps): Promise<VirtualFS> {
  if (deps.fs) return deps.fs;
  const { VirtualFS } = await import('../../fs/index.js');
  const { GLOBAL_FS_DB_NAME } = await import('../../fs/global-db.js');
  return VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
}

// ── install ─────────────────────────────────────────────────────────

async function cmdInstall(
  args: string[],
  cwd: string,
  deps: PluginCommandDeps
): Promise<ExecResult> {
  if (args.includes('--help') || args.includes('-h')) {
    return ok(`usage: plugin install <path>

Loads the Agent Plugins package at <path>: validates plugin.json (closed
schema, name constraints), discovers skills/*/SKILL.md, and validates
mcp.json. On success the plugin is recorded in
/workspace/.plugins/plugins.json — its skills then surface through the
standard skills discovery, and each supported streamable-http MCP server
is registered in the MCP store as "<plugin>:<server>".
`);
  }
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length < 1) return err('plugin install: expected <path>');

  const fs = await openVfs(deps);
  const root = resolvePath(cwd, positional[0]);
  const { loadPluginFromDirectory } = await import('../plugins/loader.js');
  const result = await loadPluginFromDirectory(fs, root);

  if (!result.ok) {
    return err(
      `plugin install: plugin at ${root} was rejected:\n${formatDiagnostics(result.diagnostics)}`
    );
  }
  const { plugin } = result;
  const name = plugin.manifest.name;

  const { getInstalledPlugin, setInstalledPlugin } = await import('../plugins/store.js');
  const existing = await getInstalledPlugin(name, deps.fs);
  if (existing && existing.root !== root) {
    return err(
      `plugin install: a plugin named "${name}" is already installed from ${existing.root} (remove it first)`
    );
  }

  const mcpNames = await bridgeMcpServers(plugin, deps);

  await setInstalledPlugin(
    name,
    {
      root,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      installedAt: new Date().toISOString(),
      mcpServerNames: mcpNames,
    },
    deps.fs
  );

  const skipped = plugin.mcp.servers.filter((s) => s.status !== 'supported');
  const lines = [
    `Installed agent plugin "${name}"${plugin.manifest.version ? ` v${plugin.manifest.version}` : ''} from ${root}`,
    `  skills: ${plugin.skills.length}${plugin.skills.length > 0 ? ` (${plugin.skills.map((s) => s.name).join(', ')})` : ''}`,
    `  mcp:    ${mcpNames.length} registered${mcpNames.length > 0 ? ` (${mcpNames.join(', ')})` : ''}${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`,
  ];
  if (result.diagnostics.length > 0) {
    lines.push('Diagnostics:', formatDiagnostics(result.diagnostics));
  }
  return ok(lines.join('\n') + '\n');
}

/**
 * Register the plugin's supported streamable-http servers into the MCP
 * store as `<plugin>:<server>`. Per §7.2.2 rule 5, a connect failure is
 * reported but never blocks the install — the entry is persisted and the
 * tool catalog is fetched best-effort.
 */
async function bridgeMcpServers(plugin: LoadedPlugin, deps: PluginCommandDeps): Promise<string[]> {
  const supported = plugin.mcp.servers.filter((s) => s.status === 'supported');
  if (supported.length === 0) return [];

  const { setServer } = await import('../mcp/store.js');
  const { McpClient } = await import('../mcp/client.js');
  const registered: string[] = [];

  for (const server of supported) {
    const config = server.config!;
    const storeName = `${plugin.manifest.name}:${server.name}`;
    let tools: unknown[] = [];
    try {
      const client = new McpClient({ url: config.url, headers: config.headers });
      await client.initialize();
      tools = await client.toolsList();
    } catch (e) {
      log.warn('plugin install: MCP probe failed (registered anyway)', {
        server: storeName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    await setServer(
      storeName,
      {
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        tools: tools as never,
        addedAt: new Date().toISOString(),
      },
      deps.fs
    );
    registered.push(storeName);
  }
  return registered;
}

// ── list ────────────────────────────────────────────────────────────

async function cmdList(args: string[], deps: PluginCommandDeps): Promise<ExecResult> {
  if (args.includes('--help') || args.includes('-h')) {
    return ok('usage: plugin list\n');
  }
  const { listInstalledPlugins } = await import('../plugins/store.js');
  const plugins = await listInstalledPlugins(deps.fs);
  const names = Object.keys(plugins).sort();
  if (names.length === 0) {
    return ok('No agent plugins installed. Use `plugin install <path>`.\n');
  }
  const rows = [['NAME', 'VERSION', 'ROOT', 'MCP']];
  for (const name of names) {
    const entry = plugins[name];
    rows.push([name, entry.version ?? '-', entry.root, String(entry.mcpServerNames?.length ?? 0)]);
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  const lines = rows.map((r) => r.map((cell, col) => cell.padEnd(widths[col])).join('  '));
  return ok(lines.join('\n') + '\n');
}

// ── info ────────────────────────────────────────────────────────────

async function cmdInfo(args: string[], deps: PluginCommandDeps): Promise<ExecResult> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return args.length === 0
      ? err('plugin info: expected <name>')
      : ok('usage: plugin info <name>\n');
  }
  const name = args[0];
  const { getInstalledPlugin } = await import('../plugins/store.js');
  const entry = await getInstalledPlugin(name, deps.fs);
  if (!entry) return err(`plugin info: no installed plugin named "${name}"`);

  const fs = await openVfs(deps);
  const { loadPluginFromDirectory } = await import('../plugins/loader.js');
  const result = await loadPluginFromDirectory(fs, entry.root);
  if (!result.ok) {
    return err(
      `plugin info: plugin at ${entry.root} no longer loads:\n${formatDiagnostics(result.diagnostics)}`
    );
  }
  const { plugin } = result;
  const m = plugin.manifest;
  const lines = [
    `${m.name}${m.version ? ` v${m.version}` : ''}`,
    ...(m.description ? [`  ${m.description}`] : []),
    `  root:    ${plugin.root}`,
    ...(m.license ? [`  license: ${m.license}`] : []),
    ...(m.homepage ? [`  home:    ${m.homepage}`] : []),
    '',
    `Skills (${plugin.skills.length}):`,
    ...plugin.skills.map((s) => `  ${s.name}  ${s.description}`),
    '',
    `MCP servers (${plugin.mcp.servers.length}):`,
    ...plugin.mcp.servers.map((s) =>
      s.status === 'supported'
        ? `  ${s.name}  ${s.config!.type}  ${s.config!.url}`
        : `  ${s.name}  [skipped: ${s.reason}]`
    ),
  ];
  if (result.diagnostics.length > 0) {
    lines.push('', 'Diagnostics:', formatDiagnostics(result.diagnostics));
  }
  return ok(lines.join('\n') + '\n');
}

// ── validate ────────────────────────────────────────────────────────

async function cmdValidate(
  args: string[],
  cwd: string,
  deps: PluginCommandDeps
): Promise<ExecResult> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return args.length === 0
      ? err('plugin validate: expected <path>')
      : ok('usage: plugin validate <path>\n');
  }
  const fs = await openVfs(deps);
  const root = resolvePath(cwd, args[0]);
  const { loadPluginFromDirectory } = await import('../plugins/loader.js');
  const result = await loadPluginFromDirectory(fs, root);

  if (!result.ok) {
    return {
      stdout: '',
      stderr: `plugin validate: REJECTED\n${formatDiagnostics(result.diagnostics)}\n`,
      exitCode: 1,
    };
  }
  const { plugin } = result;
  const supported = plugin.mcp.servers.filter((s) => s.status === 'supported').length;
  const lines = [
    `plugin validate: OK — "${plugin.manifest.name}"${plugin.manifest.version ? ` v${plugin.manifest.version}` : ''}`,
    `  skills:      ${plugin.skills.length}`,
    `  mcp servers: ${supported} supported, ${plugin.mcp.servers.length - supported} skipped (mcp.json ${plugin.mcp.status})`,
  ];
  if (result.diagnostics.length > 0) {
    lines.push('Diagnostics:', formatDiagnostics(result.diagnostics));
  }
  return ok(lines.join('\n') + '\n');
}

// ── remove ──────────────────────────────────────────────────────────

async function cmdRemove(args: string[], deps: PluginCommandDeps): Promise<ExecResult> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return args.length === 0
      ? err('plugin remove: expected <name>')
      : ok('usage: plugin remove <name>\n');
  }
  const name = args[0];
  const { getInstalledPlugin, deleteInstalledPlugin } = await import('../plugins/store.js');
  const entry = await getInstalledPlugin(name, deps.fs);
  if (!entry) return err(`plugin remove: no installed plugin named "${name}"`);

  let mcpRemoved = 0;
  if (entry.mcpServerNames && entry.mcpServerNames.length > 0) {
    const { deleteServer } = await import('../mcp/store.js');
    for (const serverName of entry.mcpServerNames) {
      if (await deleteServer(serverName, deps.fs)) mcpRemoved += 1;
    }
  }
  await deleteInstalledPlugin(name, deps.fs);

  return ok(
    [
      `Removed agent plugin "${name}"`,
      `  registry:    removed`,
      `  mcp servers: ${mcpRemoved} removed`,
      `  files:       left in place (${entry.root})`,
    ].join('\n') + '\n'
  );
}

function resolvePath(cwd: string, raw: string): string {
  const joined = raw.startsWith('/') ? raw : `${cwd.replace(/\/$/, '')}/${raw}`;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function formatDiagnostics(diagnostics: PluginDiagnostic[]): string {
  return diagnostics
    .map((d) => `  ${d.level === 'error' ? 'error' : 'warn '} [${d.component}] ${d.message}`)
    .join('\n');
}
