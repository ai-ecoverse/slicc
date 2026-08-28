/**
 * `plugin` supplemental command — load Agent Plugins packages
 * (agent-plugins.org spec v1.0.0).
 *
 * Subcommands:
 *   install <path|ref>   Validate a plugin (local dir or GitHub repo) and
 *                        register it.
 *   list                 Table of installed plugins.
 *   info <name>          Manifest, skills, and MCP servers of one plugin.
 *   validate <path|ref>  Dry-run: load + report diagnostics, install nothing.
 *   remove <name>        Unregister a plugin and its MCP servers.
 *
 * The loader (`../plugins/loader.ts`) implements the spec's validation and
 * failure-isolation rules; this file orchestrates persistence and CLI
 * ergonomics. Installed skills surface through the standard skills discovery
 * (`skills/catalog.ts` reads the same registry). Supported `streamable-http`
 * MCP servers are bridged into the existing `/workspace/.mcp/servers.json`
 * store under the name `<plugin>:<server>`.
 *
 * GitHub sources reuse the `upskill` helpers (`upskill/github/`): the repo
 * ZIP is downloaded via codeload (not rate-limited) and extracted into a
 * managed directory under `/workspace/.plugins/sources/`, then installed
 * through the same loader path as a local directory.
 */

import type { Command, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import type { LoadedPlugin, PluginDiagnostic, PluginLoadResult } from '../plugins/types.js';
import { scratchDir } from '../tmpdir-env.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

/** Managed extraction root for GitHub-sourced plugins. */
export const PLUGIN_SOURCES_DIR = '/workspace/.plugins/sources';

/** Injection hooks — production code uses defaults, tests pass stubs. */
export interface PluginCommandDeps {
  /** Shared shell `VirtualFS` (falls back to the global instance). */
  fs?: VirtualFS;
  /** Proxied/secure fetch for GitHub installs (absent → local paths only). */
  fetch?: SecureFetch;
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

/**
 * `plugin` owns no value/bool flags today — only positionals. Still run the
 * shared known-flag walk so a stray `--json` / `--runtime=…` fails loudly
 * instead of being filtered as "not a path" and exiting 0 (issue #2255).
 * Callers answer `isHelpRequest` before this so `--help` never reaches here.
 */
function parsePluginArgs(
  sub: string,
  args: readonly string[]
): { ok: true; positionals: string[] } | ExecResult {
  const parsed = parseKnownFlags(args, {});
  if ('error' in parsed) return err(`plugin ${sub}: ${parsed.error}`);
  return { ok: true, positionals: parsed.positionals };
}

function helpText(): string {
  return `usage: plugin <command> [args]

Load Agent Plugins packages (agent-plugins.org spec v1.0.0): portable
directories bundling Agent Skills (skills/*/SKILL.md) and MCP servers
(mcp.json) behind a plugin.json manifest.

Commands:
  install <path|repo>  Validate the plugin and register it. <repo> is a
                       GitHub reference (owner/repo, owner/repo@branch, or
                       https://github.com/owner/repo[/tree/branch[/dir]]),
                       downloaded into ${PLUGIN_SOURCES_DIR}/.
                       Skills surface through the standard skills discovery;
                       streamable-http MCP servers are added to the MCP
                       store as "<plugin>:<server>".
  list                 List installed plugins.
  info <name>          Show manifest, skills, and MCP servers of a plugin.
  validate <path|repo> Load + report conformance diagnostics without
                       installing anything.
  remove <name>        Unregister a plugin and its bridged MCP servers.

Transport support: streamable-http only. stdio entries are skipped (no
subprocesses in the browser) and legacy sse entries are skipped, per the
spec's single-transport allowance — other components still load.

Examples:
  plugin install /workspace/my-plugin
  plugin install owner/repo
  plugin install owner/repo@branch
  plugin install https://github.com/owner/repo/tree/main/plugins/my-plugin
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
          return await cmdValidate(rest, cwd, deps, scratchDir(ctx?.env));
        case 'remove':
        case 'rm':
        case 'delete':
          return await cmdRemove(rest, deps);
        default:
          return err(`plugin: unknown subcommand "${sub}" (try \`plugin --help\`)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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

// ── source resolution (local path vs GitHub reference) ─────────────

interface GitHubPluginRef {
  owner: string;
  repo: string;
  branch?: string;
  path?: string;
  /** Normalized display string, e.g. `owner/repo@branch/sub/dir`. */
  display: string;
}

type ResolvedSource =
  | { kind: 'local'; root: string }
  | { kind: 'github'; ref: GitHubPluginRef }
  | { kind: 'error'; message: string };

/**
 * Decide whether `<path|repo>` names a local VFS directory or a GitHub
 * reference. An existing local directory always wins, so `plugin install
 * foo/bar` prefers `./foo/bar` over the GitHub repo of the same name.
 */
async function resolveSource(raw: string, cwd: string, fs: VirtualFS): Promise<ResolvedSource> {
  const root = resolvePath(cwd, raw);
  if (await fs.exists(root)) return { kind: 'local', root };

  const { parseGitHubRef } = await import('./upskill/github/github-install.js');
  const ref = parseGitHubRef(raw);
  if (ref) {
    const display = `${ref.owner}/${ref.repo}${ref.branch ? `@${ref.branch}` : ''}${ref.path ? `/${ref.path}` : ''}`;
    return { kind: 'github', ref: { ...ref, display } };
  }
  return {
    kind: 'error',
    message: `${root} does not exist and "${raw}" is not a GitHub reference (owner/repo[@branch] or https://github.com/owner/repo[/tree/branch[/dir]])`,
  };
}

function sanitizeSourceSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-');
  // A pure-dot segment (".", "..") survives the allowlist unchanged and would
  // reintroduce traversal characters if downstream code ever splits on `--`
  // or normalizes the joined name — neutralize it defensively.
  return /^\.+$/.test(cleaned) ? cleaned.replace(/\./g, '_') : cleaned;
}

/** Deterministic managed extraction dir for a GitHub-sourced plugin. */
function githubSourceDir(ref: GitHubPluginRef): string {
  const parts = [ref.owner, ref.repo, ...(ref.path ? [ref.path] : [])];
  return `${PLUGIN_SOURCES_DIR}/${parts.map(sanitizeSourceSegment).join('--')}`;
}

/**
 * Download the repo ZIP (codeload, `main`→`master` fallback) and extract
 * the plugin subtree into `destDir`. Returns an error message on failure;
 * `destDir` is left absent/unchanged unless extraction started.
 */
async function fetchGitHubPluginTo(
  ref: GitHubPluginRef,
  destDir: string,
  fs: VirtualFS,
  fetchFn: SecureFetch
): Promise<string | null> {
  const { fetchRepoZip, stripZipPrefix, writeZipFilesToDir } = await import(
    './upskill/github/github-zip.js'
  );
  const zip = await fetchRepoZip(ref.owner, ref.repo, fetchFn, ref.branch);
  if (zip.status === 'error') {
    return `failed to download ${ref.display}: ${zip.message}`;
  }
  const files = stripZipPrefix(zip.files);
  const prefix = ref.path ? ref.path.replace(/^\/|\/$/g, '') + '/' : '';
  if (!files[`${prefix}plugin.json`]) {
    return `no plugin.json found at ${ref.display} — not an Agent Plugins package`;
  }
  try {
    await fs.rm(destDir, { recursive: true });
  } catch {
    // Didn't exist — fine.
  }
  await fs.mkdir(destDir, { recursive: true });
  // `false`: the destination was just wiped, and the never-overwrite-a-dotfile
  // rule belongs to skill installs, not to agent plugins.
  const written = await writeZipFilesToDir(files, prefix, destDir, fs, false);
  if (written.length === 0) {
    return `no files found at ${ref.display}`;
  }
  return null;
}

/** Best-effort recursive delete used for staging/managed-source cleanup. */
async function removeDirBestEffort(fs: VirtualFS, dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true });
  } catch {
    // Best-effort cleanup — a leftover staging dir is harmless.
  }
}

// ── install ─────────────────────────────────────────────────────────

async function cmdInstall(
  args: string[],
  cwd: string,
  deps: PluginCommandDeps
): Promise<ExecResult> {
  if (isHelpRequest(args)) {
    return ok(`usage: plugin install <path|repo>

Loads the Agent Plugins package at <path>, or downloads it from a GitHub
reference (owner/repo, owner/repo@branch, or
https://github.com/owner/repo[/tree/branch[/dir]]) into
${PLUGIN_SOURCES_DIR}/ first. Validates plugin.json (closed
schema, name constraints), discovers skills/*/SKILL.md, and validates
mcp.json. On success the plugin is recorded in
/workspace/.plugins/plugins.json — its skills then surface through the
standard skills discovery, and each supported streamable-http MCP server
is registered in the MCP store as "<plugin>:<server>".
`);
  }
  const parsed = parsePluginArgs('install', args);
  if (!('ok' in parsed)) return parsed;
  if (parsed.positionals.length < 1) return err('plugin install: expected <path|repo>');

  const fs = await openVfs(deps);
  const source = await resolveSource(parsed.positionals[0], cwd, fs);
  if (source.kind === 'error') return err(`plugin install: ${source.message}`);

  let root: string;
  let origin: string | undefined;
  if (source.kind === 'github') {
    if (!deps.fetch) {
      return err('plugin install: GitHub installs are unavailable (no network fetch configured)');
    }
    root = githubSourceDir(source.ref);
    origin = source.ref.display;
    const fetchError = await fetchGitHubPluginTo(source.ref, root, fs, deps.fetch);
    if (fetchError) return err(`plugin install: ${fetchError}`);
  } else {
    root = source.root;
  }

  const { loadPluginFromDirectory } = await import('../plugins/loader.js');
  const result = await loadPluginFromDirectory(fs, root);

  if (!result.ok) {
    if (source.kind === 'github') await removeDirBestEffort(fs, root);
    return err(
      `plugin install: plugin at ${origin ?? root} was rejected:\n${formatDiagnostics(result.diagnostics)}`
    );
  }
  const { plugin } = result;
  const name = plugin.manifest.name;

  const { getInstalledPlugin, setInstalledPlugin } = await import('../plugins/store.js');
  const existing = await getInstalledPlugin(name, deps.fs);
  if (existing && existing.root !== root) {
    if (source.kind === 'github') await removeDirBestEffort(fs, root);
    return err(
      `plugin install: a plugin named "${name}" is already installed from ${existing.root} (remove it first)`
    );
  }

  const bridge = await bridgeMcpServers(plugin, deps);
  const staleRemoved = await removeStaleMcpServers(
    name,
    existing?.mcpServerNames,
    bridge.registered,
    deps
  );

  await setInstalledPlugin(
    name,
    {
      root,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      installedAt: new Date().toISOString(),
      mcpServerNames: bridge.registered,
      ...(origin ? { source: origin } : {}),
    },
    deps.fs
  );

  return ok(formatInstallSummary(plugin, bridge, staleRemoved, origin ?? root, result.diagnostics));
}

/** Render the multi-line success output of `plugin install`. */
function formatInstallSummary(
  plugin: LoadedPlugin,
  bridge: McpBridgeResult,
  staleRemoved: number,
  from: string,
  diagnostics: PluginDiagnostic[]
): string {
  const name = plugin.manifest.name;
  const mcpNames = bridge.registered;
  const skipped = plugin.mcp.servers.filter((s) => s.status !== 'supported');
  const lines = [
    `Installed agent plugin "${name}"${plugin.manifest.version ? ` v${plugin.manifest.version}` : ''} from ${from}`,
    `  skills: ${plugin.skills.length}${plugin.skills.length > 0 ? ` (${plugin.skills.map((s) => s.name).join(', ')})` : ''}`,
    `  mcp:    ${mcpNames.length} registered${mcpNames.length > 0 ? ` (${mcpNames.join(', ')})` : ''}${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}${staleRemoved > 0 ? `, ${staleRemoved} removed from previous install` : ''}`,
  ];
  if (bridge.conflicts.length > 0) {
    lines.push(
      `  warning: not bridged — MCP server name(s) already in use and not owned by this plugin: ${bridge.conflicts.join(', ')} (remove them with \`mcp remove\` first)`
    );
  }
  if (diagnostics.length > 0) {
    lines.push('Diagnostics:', formatDiagnostics(diagnostics));
  }
  return lines.join('\n') + '\n';
}

/**
 * Reinstall at the same root: drop MCP entries bridged by the previous
 * install that are no longer in the manifest, so they don't orphan in the
 * shared MCP store (`plugin remove` only deletes the *current* list).
 * Only entries whose `pluginOrigin` matches this plugin are deleted, so a
 * user-added server sharing the name shape is never touched.
 * Returns the number of stale entries actually deleted.
 */
async function removeStaleMcpServers(
  pluginName: string,
  previousNames: string[] | undefined,
  currentNames: string[],
  deps: PluginCommandDeps
): Promise<number> {
  const stale = (previousNames ?? []).filter((n) => !currentNames.includes(n));
  if (stale.length === 0) return 0;
  const { deleteServer, getServer } = await import('../mcp/store.js');
  let removed = 0;
  for (const serverName of stale) {
    const entry = await getServer(serverName, deps.fs);
    if (entry?.pluginOrigin !== pluginName) continue;
    if (await deleteServer(serverName, deps.fs)) removed += 1;
  }
  return removed;
}

interface McpBridgeResult {
  /** Store names registered (or refreshed) by this install. */
  registered: string[];
  /** Store names left untouched because a non-plugin entry already owns them. */
  conflicts: string[];
}

/**
 * Register the plugin's supported streamable-http servers into the MCP
 * store as `<plugin>:<server>`, tagging each entry with `pluginOrigin`.
 * A pre-existing entry not owned by this plugin (e.g. user-added via
 * `mcp add`) is never overwritten — it is reported as a conflict instead.
 * Per §7.2.2 rule 5, a connect failure is reported but never blocks the
 * install — the entry is persisted and the tool catalog is fetched
 * best-effort.
 */
async function bridgeMcpServers(
  plugin: LoadedPlugin,
  deps: PluginCommandDeps
): Promise<McpBridgeResult> {
  const supported = plugin.mcp.servers.filter((s) => s.status === 'supported');
  if (supported.length === 0) return { registered: [], conflicts: [] };

  const { getServer, setServer } = await import('../mcp/store.js');
  const { McpClient } = await import('../mcp/client.js');
  const registered: string[] = [];
  const conflicts: string[] = [];

  for (const server of supported) {
    const config = server.config!;
    const storeName = `${plugin.manifest.name}:${server.name}`;
    const existingEntry = await getServer(storeName, deps.fs);
    if (existingEntry && existingEntry.pluginOrigin !== plugin.manifest.name) {
      conflicts.push(storeName);
      continue;
    }
    let tools: unknown[] = [];
    try {
      const client = new McpClient({ url: config.url, headers: config.headers });
      await client.initialize();
      tools = await client.toolsList();
    } catch {
      // §7.2.2 rule 5: a connect failure never blocks the install — the
      // server is registered anyway and its tool catalog stays empty.
    }
    await setServer(
      storeName,
      {
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        tools: tools as never,
        addedAt: new Date().toISOString(),
        pluginOrigin: plugin.manifest.name,
      },
      deps.fs
    );
    registered.push(storeName);
  }
  return { registered, conflicts };
}

// ── list ────────────────────────────────────────────────────────────

async function cmdList(args: string[], deps: PluginCommandDeps): Promise<ExecResult> {
  if (isHelpRequest(args)) {
    return ok('usage: plugin list\n');
  }
  const parsed = parsePluginArgs('list', args);
  if (!('ok' in parsed)) return parsed;
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
  if (isHelpRequest(args)) {
    return ok('usage: plugin info <name>\n');
  }
  const parsed = parsePluginArgs('info', args);
  if (!('ok' in parsed)) return parsed;
  if (parsed.positionals.length < 1) return err('plugin info: expected <name>');
  const name = parsed.positionals[0];
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
  deps: PluginCommandDeps,
  /** Caller's own scratch root — where the GitHub staging clone lands. */
  scratch: string
): Promise<ExecResult> {
  if (isHelpRequest(args)) {
    return ok('usage: plugin validate <path|repo>\n');
  }
  const parsed = parsePluginArgs('validate', args);
  if (!('ok' in parsed)) return parsed;
  if (parsed.positionals.length < 1) return err('plugin validate: expected <path|repo>');
  const fs = await openVfs(deps);
  const source = await resolveSource(parsed.positionals[0], cwd, fs);
  if (source.kind === 'error') return err(`plugin validate: ${source.message}`);

  let root: string;
  let staging: string | null = null;
  if (source.kind === 'github') {
    if (!deps.fetch) {
      return err('plugin validate: GitHub sources are unavailable (no network fetch configured)');
    }
    staging = `${scratch}/.plugin-validate/${githubSourceDir(source.ref).split('/').pop()}`;
    const fetchError = await fetchGitHubPluginTo(source.ref, staging, fs, deps.fetch);
    if (fetchError) return err(`plugin validate: ${fetchError}`);
    root = staging;
  } else {
    root = source.root;
  }

  const { loadPluginFromDirectory } = await import('../plugins/loader.js');
  let result: PluginLoadResult;
  try {
    result = await loadPluginFromDirectory(fs, root);
  } finally {
    // The loader claims to never throw, but a loader bug or fs error would
    // otherwise leak the staging dir past the top-level catch.
    if (staging) await removeDirBestEffort(fs, staging);
  }

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
  if (isHelpRequest(args)) {
    return ok('usage: plugin remove <name>\n');
  }
  const parsed = parsePluginArgs('remove', args);
  if (!('ok' in parsed)) return parsed;
  if (parsed.positionals.length < 1) return err('plugin remove: expected <name>');
  const name = parsed.positionals[0];
  const { getInstalledPlugin, deleteInstalledPlugin } = await import('../plugins/store.js');
  const entry = await getInstalledPlugin(name, deps.fs);
  if (!entry) return err(`plugin remove: no installed plugin named "${name}"`);

  let mcpRemoved = 0;
  if (entry.mcpServerNames && entry.mcpServerNames.length > 0) {
    const { deleteServer, getServer } = await import('../mcp/store.js');
    for (const serverName of entry.mcpServerNames) {
      // Only delete entries this plugin bridged (`pluginOrigin` matches) —
      // never a user-added server that happens to share the name.
      const serverEntry = await getServer(serverName, deps.fs);
      if (serverEntry?.pluginOrigin !== name) continue;
      if (await deleteServer(serverName, deps.fs)) mcpRemoved += 1;
    }
  }
  await deleteInstalledPlugin(name, deps.fs);

  // GitHub-sourced plugins live in the managed sources dir — delete the
  // extracted files too. Local installs keep their files in place.
  const managed = entry.root.startsWith(`${PLUGIN_SOURCES_DIR}/`);
  if (managed) {
    const fs = await openVfs(deps);
    await removeDirBestEffort(fs, entry.root);
  }

  return ok(
    [
      `Removed agent plugin "${name}"`,
      `  registry:    removed`,
      `  mcp servers: ${mcpRemoved} removed`,
      managed
        ? `  files:       removed (${entry.root})`
        : `  files:       left in place (${entry.root})`,
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
