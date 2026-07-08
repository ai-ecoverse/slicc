/**
 * `mcp` supplemental command — manage MCP (Model Context Protocol) servers.
 *
 * Subcommands:
 *   add <url> <name>          Probe a server, run OAuth if 401, persist + alias.
 *   list                       Table of registered servers.
 *   delete <name>              Drop server config, alias, sprinkles, OAuth.
 *   invoke <name> [tool] …     Run a tool through the persisted server.
 *   search <query>             Find cached tools by name/description match.
 *   refresh <name>             Re-fetch tools/apps + AS discovery.
 *   auth <name>                Re-authenticate (silent renewal → popup fallback).
 *
 * Library modules in `../mcp/` do the heavy lifting; this file only orchestrates
 * persistence, OAuth, and CLI ergonomics (help text, schema-driven flag
 * coercion, result rendering). Each subcommand calls
 * `ensureMcpProviderRegistered` so the provider survives a page reload.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../core/logger.js';
import { isExtensionRealm } from '../../core/runtime-env.js';
import type { VirtualFS } from '../../fs/index.js';
import type { OAuthLauncher } from '../../providers/types.js';
import { McpTimeoutError } from '../mcp/client.js';
import type { FetchLike } from '../mcp/oauth.js';
import type { McpAppDef, McpFetchLike, McpServerEntry, McpToolDef } from '../mcp/types.js';
import type { ScriptCatalog } from '../script-catalog.js';

const log = createLogger('mcp-command');

/** Injection hooks — production code uses defaults, tests pass stubs. */
export interface McpCommandDeps {
  /** Override the MCP HTTP client's fetch. */
  fetchImpl?: McpFetchLike;
  /** Override the OAuth discovery/exchange fetch. */
  oauthFetchImpl?: FetchLike;
  /** Override the OAuth browser launcher. */
  oauthLauncher?: OAuthLauncher;
  /**
   * Shared shell `VirtualFS`. When present, alias shims, the server
   * store, and the sprinkles writes all go through this instance so
   * the shell's `ScriptCatalog` FsWatcher fires immediately. When
   * absent (tests / legacy callers), the store/apps modules fall back
   * to opening their own `GLOBAL_FS_DB_NAME` instance.
   */
  fs?: VirtualFS;
  /**
   * Shared script-discovery catalog. When present, `mcp add` /
   * `mcp delete` invalidate the `.jsh` cache after writing/removing
   * the alias so the new (or removed) command resolves on the PATH
   * in the same shell session.
   */
  scriptCatalog?: ScriptCatalog;
}

const ALIASES_DIR = '/workspace/.mcp/aliases';

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
  return `usage: mcp <command> [args]

Commands:
  add <url> <name>           Register an MCP server. Runs OAuth if required.
  list                       List configured MCP servers.
  delete <name>              Remove a server, its alias, sprinkles, and OAuth.
  invoke <name> [tool] …     Call a tool through a configured server.
  search <query>             Find cached tools by name/description match.
  refresh <name>             Re-fetch tools/apps and AS metadata.
  auth <name>                Re-authenticate an MCP server (silent renewal,
                             with an interactive popup fallback). Use this
                             when a token has expired; \`refresh\` only
                             reloads the tool catalog and does not touch
                             OAuth.

Examples:
  mcp add https://mcp.example.com/sse weather
  mcp list
  mcp invoke weather get-forecast --lat 51.5 --lon -0.12
  mcp search forecast
  mcp auth weather
  mcp delete weather
`;
}

export function createMcpCommand(deps: McpCommandDeps = {}): Command {
  return defineCommand('mcp', async (args): Promise<ExecResult> => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return ok(helpText());
    }
    const sub = args[0];
    const rest = args.slice(1);
    try {
      switch (sub) {
        case 'add':
          return await cmdAdd(rest, deps);
        case 'list':
        case 'ls':
          return await cmdList(rest, deps);
        case 'delete':
        case 'rm':
          return await cmdDelete(rest, deps);
        case 'invoke':
          return await cmdInvoke(rest, deps);
        case 'search':
          return await cmdSearch(rest, deps);
        case 'refresh':
          return await cmdRefresh(rest, deps);
        case 'auth':
          return await cmdAuth(rest, deps);
        default:
          return err(`mcp: unknown subcommand "${sub}" (try \`mcp --help\`)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('mcp subcommand failed', { sub, error: msg });
      if (e instanceof McpTimeoutError) return err(`mcp ${sub}: ${msg}`, 124);
      return err(`mcp ${sub}: ${msg}`);
    }
  });
}

// ── add ─────────────────────────────────────────────────────────────

async function cmdAdd(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args.includes('--help') || args.includes('-h')) {
    return ok(`usage: mcp add <url> <name>

Probes <url> with an unauthenticated MCP \`initialize\`. If the server
returns 401, runs OAuth discovery → dynamic client registration → PKCE
authorization-code flow, stores the access token, and retries.

On success, the server is persisted to /workspace/.mcp/servers.json and
an alias shim is written to /workspace/.mcp/aliases/<name>.jsh so the
short name resolves on the PATH.
`);
  }
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length < 2) {
    return err('mcp add: expected <url> <name>');
  }
  const [url, name] = positional;
  if (!/^https?:\/\//i.test(url)) {
    return err(`mcp add: invalid URL "${url}" (must start with http:// or https://)`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    return err(
      `mcp add: invalid name "${name}" (letters, digits, _ and - only; must start with a letter)`
    );
  }

  const { getServer, setServer } = await import('../mcp/store.js');
  const existing = await getServer(name, deps.fs);
  if (existing) {
    return err(`mcp add: a server named "${name}" already exists`);
  }

  // Step 1: bare initialize (no auth)
  const { McpClient, McpAuthRequiredError } = await import('../mcp/client.js');
  let client = new McpClient({ url, fetchImpl: deps.fetchImpl });
  let authBlock: McpServerEntry['auth'];

  try {
    await client.initialize();
  } catch (e) {
    if (!(e instanceof McpAuthRequiredError)) throw e;
    // Step 2: discover + register + run PKCE flow
    authBlock = await runOAuthForAdd(url, name, e.resourceMetadataUrl, deps);
    // Step 3: retry initialize with token
    client = new McpClient({
      url,
      fetchImpl: deps.fetchImpl,
      getAuthHeader: () => getMcpBearerHeader(name),
    });
    await client.initialize();
  }

  // Step 4: fetch tools + apps
  const tools = await client.toolsList();
  const apps = await client.appsList();

  // Step 5: persist
  const now = new Date().toISOString();
  // Note: do NOT persist `sessionId`. Sessions are issued by the server on
  // every `initialize` and don't survive across reloads — sending a stale
  // id on the next `initialize` is a Streamable-HTTP protocol violation.
  const entry: McpServerEntry = {
    url,
    tools,
    apps,
    addedAt: now,
    lastRefreshedAt: now,
    ...(authBlock ? { auth: authBlock } : {}),
  };
  await setServer(name, entry, deps.fs);

  // Step 6: alias shim
  await writeAliasShim(name, deps);

  // Step 7: materialize Apps as sprinkles (best-effort)
  const sprinkles = await materializeAppSprinklesSafe(name, apps, deps);

  // Step 8: register the provider in-session (if we set up OAuth)
  if (authBlock) {
    const { registerMcpProvider } = await import('../mcp/provider.js');
    registerMcpProvider({ name, serverUrl: url, auth: authBlock });
  }

  const lines = [
    `Added MCP server "${name}" → ${url}`,
    `  tools: ${tools.length}, apps: ${apps.length} (${sprinkles} sprinkle${sprinkles === 1 ? '' : 's'})`,
    `  alias: ${ALIASES_DIR}/${name}.jsh`,
    authBlock ? `  auth:  oauth (provider mcp:${name})` : '  auth:  none',
  ];
  return ok(lines.join('\n') + '\n');
}

async function runOAuthForAdd(
  serverUrl: string,
  name: string,
  resourceMetadataUrl: string | undefined,
  deps: McpCommandDeps
): Promise<NonNullable<McpServerEntry['auth']>> {
  const { discoverAuth, dynamicRegister, runAuthFlow } = await import('../mcp/oauth.js');
  const { saveOAuthAccount } = await import('../../ui/provider-settings.js');
  const fetchImpl = await resolveOAuthFetchImpl(deps.oauthFetchImpl);
  const launcher = deps.oauthLauncher ?? (await defaultLauncher());

  const asMetadata = await discoverAuth(serverUrl, resourceMetadataUrl, fetchImpl);
  log.debug('MCP OAuth discovery succeeded', {
    name,
    serverUrl,
    discoveryPath: asMetadata.discoveryPath,
    issuer: asMetadata.issuer,
  });
  const redirectUri = await defaultRedirectUri();
  const dcr = await dynamicRegister(asMetadata, redirectUri, fetchImpl);
  const scope =
    asMetadata.supportedScopes && asMetadata.supportedScopes.length > 0
      ? asMetadata.supportedScopes.join(' ')
      : undefined;

  const token = await runAuthFlow({
    asMetadata,
    clientId: dcr.clientId,
    scope,
    redirectUri,
    launcher,
    fetchImpl,
  });

  const providerId = `mcp:${name}`;
  await saveOAuthAccount({
    providerId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenExpiresAt: token.expiresAt,
  });

  return {
    providerId,
    authorizationServer: asMetadata.issuer,
    clientId: dcr.clientId,
    scope: token.scope ?? scope,
    registrationClientUri: dcr.registrationClientUri,
  };
}

// ── list ────────────────────────────────────────────────────────────

async function cmdList(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args.includes('--help') || args.includes('-h')) {
    return ok('usage: mcp list\n');
  }
  const { ensureAllMcpProvidersRegistered } = await import('../mcp/provider.js');
  await ensureAllMcpProvidersRegistered();
  const { listServers } = await import('../mcp/store.js');
  const servers = await listServers(deps.fs);
  const names = Object.keys(servers).sort();
  if (names.length === 0) {
    return ok('No MCP servers configured. Use `mcp add <url> <name>`.\n');
  }
  const rows = [['NAME', 'URL', 'AUTH', 'TOOLS', 'APPS', 'ADDED']];
  for (const n of names) {
    const e = servers[n];
    rows.push([
      n,
      e.url,
      e.auth ? 'yes' : 'no',
      String(e.tools?.length ?? 0),
      String(e.apps?.length ?? 0),
      e.addedAt ? e.addedAt.slice(0, 10) : '-',
    ]);
  }
  return ok(formatTable(rows));
}

function formatTable(rows: string[][]): string {
  const widths = rows[0].map((_, col) =>
    rows.reduce((max, row) => Math.max(max, (row[col] ?? '').length), 0)
  );
  return (
    rows
      .map((row) =>
        row
          .map((cell, col) => cell.padEnd(widths[col]))
          .join('  ')
          .trimEnd()
      )
      .join('\n') + '\n'
  );
}

// ── search ──────────────────────────────────────────────────────────

async function cmdSearch(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args[0] === '--help' || args[0] === '-h') {
    return ok(`usage: mcp search <query>

Case-insensitive substring search across the cached tools of every
registered MCP server. Matches tool name OR description and prints a
table of (server, tool, description, match-field) rows.
`);
  }
  if (args.length === 0) {
    return err('mcp search: expected <query>');
  }
  const query = args[0];
  const needle = query.toLowerCase();

  const { ensureAllMcpProvidersRegistered } = await import('../mcp/provider.js');
  await ensureAllMcpProvidersRegistered();
  const { listServers } = await import('../mcp/store.js');
  const servers = await listServers(deps.fs);
  const names = Object.keys(servers).sort();
  if (names.length === 0) {
    return ok('No MCP servers configured. Use `mcp add <url> <name>`.\n');
  }

  interface Hit {
    server: string;
    tool: string;
    description: string;
    match: string;
  }
  const hits: Hit[] = [];
  for (const n of names) {
    const tools = servers[n].tools ?? [];
    for (const t of tools) {
      const desc = t.description ?? '';
      const nameHit = t.name.toLowerCase().includes(needle);
      const descHit = desc.toLowerCase().includes(needle);
      if (!nameHit && !descHit) continue;
      const match = nameHit && descHit ? 'name+description' : nameHit ? 'name' : 'description';
      hits.push({ server: n, tool: t.name, description: desc, match });
    }
  }

  if (hits.length === 0) {
    return ok(`No tools matched "${query}".\n`);
  }
  hits.sort((a, b) =>
    a.server === b.server ? a.tool.localeCompare(b.tool) : a.server.localeCompare(b.server)
  );

  const rows = [['SERVER', 'TOOL', 'DESCRIPTION', 'MATCH']];
  for (const h of hits) {
    rows.push([h.server, h.tool, truncateDescription(h.description), h.match]);
  }
  return ok(formatTable(rows));
}

function truncateDescription(desc: string): string {
  if (!desc) return '';
  const single = desc.replace(/\s+/g, ' ').trim();
  if (single.length <= 60) return single;
  return single.slice(0, 59) + '…';
}

// ── delete ──────────────────────────────────────────────────────────

async function cmdDelete(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return args.length === 0
      ? err('mcp delete: expected <name>')
      : ok('usage: mcp delete <name>\n');
  }
  const name = args[0];
  const { ensureMcpProviderRegistered, removeMcpProvider } = await import('../mcp/provider.js');
  await ensureMcpProviderRegistered(name);
  const { deleteServer } = await import('../mcp/store.js');
  const removedServer = await deleteServer(name, deps.fs);

  // Best-effort filesystem cleanup. The store ENOENT path already
  // tolerates a missing file, but the alias + sprinkles paths are
  // independent so we swallow ENOENT individually.
  await removeAliasShim(name, deps);
  await removeSprinklesDir(name, deps);

  const providerId = `mcp:${name}`;
  let oauthRemoved = false;
  try {
    const { removeAccount, getAccounts } = await import('../../ui/provider-settings.js');
    if (getAccounts().some((a) => a.providerId === providerId)) {
      await removeAccount(providerId);
      oauthRemoved = true;
    }
  } catch (e) {
    log.warn('mcp delete: OAuth removal failed', {
      providerId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const providerRemoved = removeMcpProvider(name);

  if (!removedServer && !oauthRemoved && !providerRemoved) {
    return err(`mcp delete: no server, alias, or account found for "${name}"`);
  }
  return ok(
    [
      `Removed MCP server "${name}"`,
      `  servers.json: ${removedServer ? 'removed' : 'not present'}`,
      `  alias:        cleaned`,
      `  sprinkles:    cleaned`,
      `  oauth:        ${oauthRemoved ? 'removed' : 'not present'}`,
      `  provider:     ${providerRemoved ? 'unregistered' : 'not registered'}`,
    ].join('\n') + '\n'
  );
}

// ── invoke ──────────────────────────────────────────────────────────

async function cmdInvoke(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return args.length === 0 ? err('mcp invoke: expected <name>') : ok(invokeHelpText());
  }
  const name = args[0];
  const rest = args.slice(1);

  const { ensureMcpProviderRegistered } = await import('../mcp/provider.js');
  await ensureMcpProviderRegistered(name);

  const { getServer } = await import('../mcp/store.js');
  const entry = await getServer(name, deps.fs);
  if (!entry) {
    return err(`mcp invoke: unknown server "${name}" (run \`mcp add <url> ${name}\` first)`);
  }

  const tools = entry.tools ?? [];

  // No tool → server-level help (list tools).
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    return ok(formatServerHelp(name, entry, tools));
  }

  const toolName = rest[0];
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return err(
      `mcp invoke: unknown tool "${toolName}" on "${name}" (run \`${name}\` to list tools)`
    );
  }

  const toolArgs = rest.slice(1);
  // `--timeout <sec>` is a slicc-level flag — strip it before the tool-args
  // parser runs so it isn't mistaken for a tool input. Invalid values warn
  // on stderr and fall back to the McpClient default rather than erroring.
  const { timeoutMs, remaining: filteredArgs, warnings } = extractTimeoutFlag(toolArgs);

  if (filteredArgs.includes('--help') || filteredArgs.includes('-h')) {
    return ok(formatToolHelp(name, tool));
  }

  const coerced = coerceArgsBySchema(filteredArgs, tool.inputSchema);
  if (!coerced.ok) return err(`mcp invoke: ${coerced.error}`);

  const { McpClient } = await import('../mcp/client.js');
  const client = new McpClient({
    url: entry.url,
    fetchImpl: deps.fetchImpl,
    headers: entry.headers,
    getAuthHeader: entry.auth ? () => getMcpBearerHeader(name) : undefined,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  await client.initialize();
  const result = await client.toolsCall(toolName, coerced.value);
  const rendered = renderToolResult(result);
  if (warnings.length > 0) {
    rendered.stderr = warnings.map((w) => `${w}\n`).join('') + rendered.stderr;
  }
  return rendered;
}

interface TimeoutExtraction {
  timeoutMs: number | undefined;
  remaining: string[];
  warnings: string[];
}

/**
 * Pull `--timeout <seconds>` / `--timeout=<seconds>` out of the args before
 * they reach the tool-args parser. Returns the remaining args plus the
 * resolved timeout in ms (or `undefined` to fall back to the client default).
 * Invalid values produce a warning string but never throw.
 */
export function extractTimeoutFlag(args: string[]): TimeoutExtraction {
  const remaining: string[] = [];
  const warnings: string[] = [];
  let timeoutMs: number | undefined;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a.startsWith('--timeout=')) {
      const raw = a.slice('--timeout='.length);
      const parsed = parseTimeoutSeconds(raw);
      if (parsed.ok) timeoutMs = parsed.value;
      else warnings.push(parsed.error);
      i += 1;
      continue;
    }
    if (a === '--timeout') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        warnings.push(
          `mcp invoke: --timeout requires a value (got ${next === undefined ? 'nothing' : `"${next}"`}); using default.`
        );
        i += 1;
        continue;
      }
      const parsed = parseTimeoutSeconds(next);
      if (parsed.ok) timeoutMs = parsed.value;
      else warnings.push(parsed.error);
      i += 2;
      continue;
    }
    remaining.push(a);
    i += 1;
  }
  return { timeoutMs, remaining, warnings };
}

function parseTimeoutSeconds(
  raw: string
): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^-?\d+$/.test(raw)) {
    return {
      ok: false,
      error: `mcp invoke: invalid --timeout value "${raw}" (expected positive integer seconds); using default.`,
    };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return {
      ok: false,
      error: `mcp invoke: invalid --timeout value "${raw}" (must be >= 1 second); using default.`,
    };
  }
  return { ok: true, value: n * 1000 };
}

function invokeHelpText(): string {
  return `usage: mcp invoke <name> [tool] [--timeout <seconds>] [--flag value …]

  mcp invoke <name>                   List tools on <name>.
  mcp invoke <name> <tool> --help     Show flags for <tool>.
  mcp invoke <name> <tool> --foo bar  Call <tool> with arguments.

Slicc-level options (consumed before tool args):
  --timeout <seconds>   Override the per-request timeout (default 60s).
                        Must be a positive integer; invalid values warn
                        on stderr and fall back to the default.
                        A timeout exits with code 124 (matching GNU
                        timeout(1)) so scripts can branch on it.

Arguments are coerced according to the tool's JSON Schema:
  string/integer/number/boolean. Bare \`--flag\` (no value or "--" next)
  is treated as true. Repeating a flag accumulates into an array when
  the schema declares \`type: array\`.
`;
}

function formatServerHelp(name: string, entry: McpServerEntry, tools: McpToolDef[]): string {
  const lines: string[] = [];
  lines.push(`MCP server "${name}" → ${entry.url}`);
  if (tools.length === 0) {
    lines.push('  (no tools cached — run `mcp refresh ' + name + '`)');
  } else {
    lines.push('');
    lines.push('Tools:');
    const width = tools.reduce((m, t) => Math.max(m, t.name.length), 0);
    for (const t of tools) {
      lines.push(`  ${t.name.padEnd(width)}  ${t.description ?? ''}`.trimEnd());
    }
    lines.push('');
    lines.push(`Run \`${name} <tool> --help\` for tool-specific flags.`);
  }
  return lines.join('\n') + '\n';
}

function formatToolHelp(name: string, tool: McpToolDef): string {
  const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const lines: string[] = [];
  lines.push(`usage: ${name} ${tool.name} [flags]`);
  if (tool.description) {
    lines.push('');
    lines.push(tool.description);
  }
  const propNames = Object.keys(properties);
  if (propNames.length === 0) {
    lines.push('');
    lines.push('(no flags declared)');
    return lines.join('\n') + '\n';
  }
  lines.push('');
  lines.push('Flags:');
  const labels = propNames.map((p) => {
    const meta = properties[p] ?? {};
    const type = typeof meta.type === 'string' ? meta.type : 'string';
    return `  --${p} <${type}>`;
  });
  const width = labels.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < propNames.length; i++) {
    const p = propNames[i];
    const meta = properties[p] ?? {};
    const desc = typeof meta.description === 'string' ? (meta.description as string) : '';
    const req = required.has(p) ? ' (required)' : '';
    lines.push(`${labels[i].padEnd(width)}  ${desc}${req}`.trimEnd());
  }
  return lines.join('\n') + '\n';
}

interface CoerceResult {
  ok: true;
  value: Record<string, unknown>;
}
interface CoerceErr {
  ok: false;
  error: string;
}

/** Coerce `--flag value` pairs against a JSON Schema object. */
export function coerceArgsBySchema(args: string[], schema: unknown): CoerceResult | CoerceErr {
  const s = (schema ?? {}) as Record<string, unknown>;
  const properties = (s.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const out: Record<string, unknown> = {};

  let i = 0;
  while (i < args.length) {
    const result = parseOneFlag(args, i, properties, out);
    if (!result.ok) return result;
    i = result.nextIndex;
  }

  for (const r of required) {
    if (!(r in out)) {
      return { ok: false, error: `missing required flag --${r}` };
    }
  }
  return { ok: true, value: out };
}

/** Parse a single --flag from `args` at position `i`, writing into `out`. */
function parseOneFlag(
  args: string[],
  i: number,
  properties: Record<string, Record<string, unknown>>,
  out: Record<string, unknown>
): (CoerceErr & { nextIndex?: never }) | { ok: true; nextIndex: number } {
  const a = args[i];
  if (!a.startsWith('--')) {
    return { ok: false, error: `unexpected positional argument "${a}"` };
  }
  const { key, inlineValue } = splitFlag(a);
  const meta = properties[key];
  const type = typeof meta?.type === 'string' ? (meta.type as string) : 'string';
  const isArray = type === 'array';
  const itemType =
    isArray && meta?.items && typeof (meta.items as Record<string, unknown>).type === 'string'
      ? ((meta.items as Record<string, unknown>).type as string)
      : 'string';

  let raw: string | undefined = inlineValue;
  let nextIndex: number;
  if (raw === undefined) {
    const next = args[i + 1];
    if (type === 'boolean' && (next === undefined || next.startsWith('--'))) {
      out[key] = true;
      return { ok: true, nextIndex: i + 1 };
    }
    if (next === undefined) {
      return { ok: false, error: `flag --${key} requires a value` };
    }
    raw = next;
    nextIndex = i + 2;
  } else {
    nextIndex = i + 1;
  }

  const coerced = coerceScalar(raw, isArray ? itemType : type);
  if (!coerced.ok) return { ok: false, error: `--${key}: ${coerced.error}` };
  if (isArray) {
    const prev = out[key];
    if (Array.isArray(prev)) prev.push(coerced.value);
    else out[key] = [coerced.value];
  } else {
    out[key] = coerced.value;
  }
  return { ok: true, nextIndex };
}

/** Split `--key=value` or `--key` into key + optional inline value. */
function splitFlag(a: string): { key: string; inlineValue: string | undefined } {
  const eq = a.indexOf('=');
  if (eq > 2) return { key: a.slice(2, eq), inlineValue: a.slice(eq + 1) };
  return { key: a.slice(2), inlineValue: undefined };
}

function coerceScalar(
  raw: string,
  type: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (type) {
    case 'integer': {
      if (!/^-?\d+$/.test(raw)) return { ok: false, error: `expected integer, got "${raw}"` };
      return { ok: true, value: Number(raw) };
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `expected number, got "${raw}"` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (raw === 'true' || raw === '1' || raw === 'yes') return { ok: true, value: true };
      if (raw === 'false' || raw === '0' || raw === 'no') return { ok: true, value: false };
      return { ok: false, error: `expected boolean, got "${raw}"` };
    }
    default:
      return { ok: true, value: raw };
  }
}

interface ToolResultContent {
  type?: string;
  text?: string;
  data?: unknown;
  mimeType?: string;
  resource?: { uri?: string };
  uri?: string;
}

interface ToolResultEnvelope {
  isError?: boolean;
  content?: ToolResultContent[];
}

export function renderToolResult(raw: unknown): ExecResult {
  const result = (raw ?? {}) as ToolResultEnvelope;
  const content = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') parts.push(c.text);
        break;
      case 'image':
        parts.push(`[image: ${c.mimeType ?? 'unknown mime'}]`);
        break;
      case 'resource': {
        const uri = c.resource?.uri ?? c.uri ?? 'unknown uri';
        parts.push(`[resource: ${uri}]`);
        break;
      }
      default:
        parts.push(`[${c.type ?? 'unknown'}]`);
    }
  }
  const text = parts.join('\n');
  const trailingNl = text.endsWith('\n') ? '' : '\n';
  if (result.isError) {
    return { stdout: '', stderr: (text || '(tool reported error)') + trailingNl, exitCode: 1 };
  }
  return { stdout: text + (text ? trailingNl : ''), stderr: '', exitCode: 0 };
}

// ── refresh ─────────────────────────────────────────────────────────

async function cmdRefresh(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return args.length === 0
      ? err('mcp refresh: expected <name>')
      : ok(
          `usage: mcp refresh <name>

Re-fetches the tool catalog and \`apps/list\` for <name>. Does NOT refresh
OAuth tokens — for OAuth token refresh use \`mcp auth <name>\`.
`
        );
  }
  const name = args[0];
  const { ensureMcpProviderRegistered } = await import('../mcp/provider.js');
  await ensureMcpProviderRegistered(name);

  const { getServer, setServer } = await import('../mcp/store.js');
  const entry = await getServer(name, deps.fs);
  if (!entry) return err(`mcp refresh: unknown server "${name}"`);

  const { McpClient, McpAuthRequiredError } = await import('../mcp/client.js');
  const client = new McpClient({
    url: entry.url,
    fetchImpl: deps.fetchImpl,
    headers: entry.headers,
    getAuthHeader: entry.auth ? () => getMcpBearerHeader(name) : undefined,
  });
  try {
    await client.initialize();
  } catch (e) {
    if (e instanceof McpAuthRequiredError) {
      return err(
        `mcp refresh: server "${name}" returned 401 — token may have expired. Run \`mcp auth ${name}\` to re-authenticate.`
      );
    }
    throw e;
  }
  const tools = await client.toolsList();
  const apps = await client.appsList();
  // Drop any previously persisted `sessionId` — it's per-process state on
  // the server and unsafe to re-send on the next `initialize`. Setting it
  // to `undefined` ensures JSON.stringify in `writeServersFile` drops it
  // even though `setServer` shallow-merges with the existing record.
  const merged: McpServerEntry = {
    ...entry,
    sessionId: undefined,
    tools,
    apps,
    lastRefreshedAt: new Date().toISOString(),
  };
  await setServer(name, merged, deps.fs);
  const sprinkles = await materializeAppSprinklesSafe(name, apps, deps);
  return ok(
    `Refreshed "${name}" — tools: ${tools.length}, apps: ${apps.length} (${sprinkles} sprinkle${sprinkles === 1 ? '' : 's'})\n`
  );
}

// ── auth ────────────────────────────────────────────────────────────

async function cmdAuth(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args.includes('--help') || args.includes('-h')) {
    return ok(`usage: mcp auth <name> [--silent | --interactive]

Re-authenticate an existing MCP server. By default, attempts a silent
token renewal using the persisted refresh_token; if that returns no
token, falls back to an interactive popup flow.

Options:
  -s, --silent        Only attempt silent renewal. Exit non-zero if it
                      fails (no popup). Useful in scripts.
  -i, --interactive   Skip silent renewal and open the OAuth popup
                      directly. Use after revoking a refresh token or
                      when the AS no longer accepts the cached one.
`);
  }
  const positional = args.filter((a) => !a.startsWith('-'));
  if (positional.length === 0) {
    return err('mcp auth: expected <name>');
  }
  const name = positional[0];
  const silent = args.includes('--silent') || args.includes('-s');
  const interactive = args.includes('--interactive') || args.includes('-i');
  if (silent && interactive) {
    return err('mcp auth: --silent and --interactive are mutually exclusive');
  }

  const { ensureMcpProviderRegistered } = await import('../mcp/provider.js');
  const registered = await ensureMcpProviderRegistered(name);

  const { getServer } = await import('../mcp/store.js');
  const entry = await getServer(name, deps.fs);
  if (!entry) {
    return err(`mcp auth: unknown server "${name}" (run \`mcp list\` to see configured servers)`);
  }
  if (!entry.auth) {
    return err(`mcp auth: server "${name}" does not use OAuth`);
  }
  if (!registered) {
    // ensureMcpProviderRegistered returned false despite an auth block;
    // surface a clear error rather than silently failing on the next step.
    return err(`mcp auth: failed to register provider for "${name}"`);
  }

  const providerId = `mcp:${name}`;
  const { getRegisteredProviderConfig } = await import('../../providers/index.js');
  const cfg = getRegisteredProviderConfig(providerId);
  if (!cfg) {
    return err(`mcp auth: provider "${providerId}" is not registered`);
  }

  if (interactive) {
    return await runInteractiveAuth(name, cfg, deps);
  }

  // Default + --silent: try silent renewal first.
  if (!cfg.onSilentRenew) {
    if (silent) {
      return err(
        `mcp auth: provider "${providerId}" does not support silent renewal; retry without --silent`
      );
    }
    return await runInteractiveAuth(name, cfg, deps);
  }

  let renewed: string | null = null;
  try {
    renewed = await cfg.onSilentRenew();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (silent) {
      return err(
        `mcp auth: silent renewal for "${name}" failed (${msg}); retry without --silent to run the interactive flow`
      );
    }
    log.debug('mcp auth: silent renewal threw, falling back to interactive', { name, error: msg });
  }
  if (renewed) {
    return ok(`Re-authenticated "${name}" via silent renewal (provider ${providerId})\n`);
  }
  if (silent) {
    return err(
      `mcp auth: silent renewal for "${name}" returned no token; retry without --silent to run the interactive flow`
    );
  }
  return await runInteractiveAuth(name, cfg, deps);
}

async function runInteractiveAuth(
  name: string,
  cfg: import('../../providers/types.js').ProviderConfig,
  deps: McpCommandDeps
): Promise<ExecResult> {
  if (!cfg.onOAuthLogin) {
    return err(`mcp auth: provider "${cfg.id}" does not support interactive OAuth login`);
  }
  const launcher = deps.oauthLauncher ?? (await defaultLauncher());
  let success = false;
  await cfg.onOAuthLogin(launcher, () => {
    success = true;
  });
  if (!success) {
    return err(`mcp auth: interactive login for "${name}" did not complete`);
  }
  return ok(`Re-authenticated "${name}" via interactive login (provider ${cfg.id})\n`);
}

// ── helpers ─────────────────────────────────────────────────────────

async function getMcpBearerHeader(name: string): Promise<string | null> {
  const providerId = `mcp:${name}`;
  const { getOAuthAccountInfo } = await import('../../ui/provider-settings.js');
  const info = getOAuthAccountInfo(providerId);
  if (!info) return null;
  if (info.expired) {
    // Best-effort silent renewal — if the provider config is registered
    // we ask it to rotate the token. Failure surfaces as a 401 from the
    // server, which the caller already handles.
    try {
      const { getRegisteredProviderConfig } = await import('../../providers/index.js');
      const cfg = getRegisteredProviderConfig(providerId);
      const renewed = await cfg?.onSilentRenew?.();
      if (renewed) return `Bearer ${renewed}`;
    } catch (e) {
      log.debug('silent renewal threw', {
        providerId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return null;
  }
  return `Bearer ${info.token}`;
}

async function defaultLauncher(): Promise<OAuthLauncher> {
  const { createOAuthLauncher } = await import('../../providers/oauth-service.js');
  return createOAuthLauncher();
}

async function defaultRedirectUri(): Promise<string> {
  // Extension offscreen runtime: the OAuth launcher routes through
  // `chrome.identity.launchWebAuthFlow`, which only captures redirects
  // matching the deterministic `<extension-id>.chromiumapp.org` URL.
  // Both the authorize URL and the token-exchange redirect_uri must use
  // the same value (RFC 6749 §10.6).
  if (isExtensionRealm()) {
    const chromeApi = chrome as any;
    return (
      chromeApi.identity?.getRedirectURL?.('mcp-callback') ??
      `https://${chromeApi.runtime.id}.chromiumapp.org/mcp-callback`
    );
  }
  // CLI / standalone webapp: the popup→postMessage + /api/oauth-result
  // polling path captures the redirect on the page origin.
  const { getOAuthPageOrigin } = await import('../../providers/oauth-service.js');
  const { origin } = await getOAuthPageOrigin();
  return `${origin}/auth/callback`;
}

async function resolveOAuthFetchImpl(override?: FetchLike): Promise<FetchLike> {
  if (override) return override;
  const { createProxiedFetch } = await import('../proxied-fetch.js');
  const fn = createProxiedFetch();
  return async (url, init) => {
    const res = await fn(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const decoder = new TextDecoder();
    const bodyText = decoder.decode(res.body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText,
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText) as unknown,
      headers: {
        get: (n: string) => res.headers[n.toLowerCase()] ?? null,
      },
    };
  };
}

interface AliasFs {
  readFile: (p: string, opts?: { encoding?: 'utf-8' | 'binary' }) => Promise<unknown>;
  writeFile: (p: string, c: string | Uint8Array) => Promise<void>;
  mkdir: (p: string, o?: { recursive?: boolean }) => Promise<void>;
  rm: (p: string, o?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  exists: (p: string) => Promise<boolean>;
}

async function openGlobalFs(injected?: VirtualFS | null): Promise<AliasFs> {
  if (injected) return injected as unknown as AliasFs;
  const { VirtualFS: V } = await import('../../fs/index.js');
  const { GLOBAL_FS_DB_NAME } = await import('../../fs/global-db.js');
  return (await V.create({ dbName: GLOBAL_FS_DB_NAME })) as unknown as AliasFs;
}

function aliasContent(name: string): string {
  return `// MCP alias for "${name}" — forwards args to \`mcp invoke ${name}\`.
// Auto-generated by \`mcp add ${name}\`; do not edit by hand.
const argv = Array.isArray(process.argv) ? process.argv.slice(2) : [];
const escape = (s) => {
  const v = String(s);
  if (v === '') return "''";
  if (/^[A-Za-z0-9_\\-+.,:\\/=@%]+$/.test(v)) return v;
  return "'" + v.replace(/'/g, "'\\\\''") + "'";
};
const cmd = ['mcp', 'invoke', ${JSON.stringify(name)}, ...argv.map(escape)].join(' ');
const r = await exec(cmd);
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.exitCode || 0);
`;
}

async function writeAliasShim(name: string, deps: McpCommandDeps): Promise<void> {
  const fs = await openGlobalFs(deps.fs);
  await fs.mkdir(ALIASES_DIR, { recursive: true });
  await fs.writeFile(`${ALIASES_DIR}/${name}.jsh`, aliasContent(name));
  // Drop the cached `.jsh` listing so the new alias resolves on the
  // PATH within the same shell session. The catalog's FsWatcher only
  // fires for writes through the same `VirtualFS` instance; when
  // `deps.fs` is the shared shell FS this is redundant-but-cheap,
  // and when it's a separate cached instance (e.g. `openGlobalFs()`
  // fallback) the invalidation is what makes the alias visible.
  deps.scriptCatalog?.invalidateJsh();
}

async function removeAliasShim(name: string, deps: McpCommandDeps): Promise<void> {
  const fs = await openGlobalFs(deps.fs);
  const path = `${ALIASES_DIR}/${name}.jsh`;
  try {
    if (await fs.exists(path)) await fs.rm(path);
  } catch (e) {
    log.debug('alias removal failed', {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  deps.scriptCatalog?.invalidateJsh();
}

async function removeSprinklesDir(name: string, deps: McpCommandDeps): Promise<void> {
  const { removeAppSprinkles } = await import('../mcp/apps.js');
  await removeAppSprinkles(name, deps.fs as unknown as Parameters<typeof removeAppSprinkles>[1]);
}

async function materializeAppSprinklesSafe(
  name: string,
  apps: McpAppDef[],
  deps: McpCommandDeps
): Promise<number> {
  try {
    const { materializeAppSprinkles } = await import('../mcp/apps.js');
    const written = await materializeAppSprinkles(
      name,
      apps,
      deps.fs as unknown as Parameters<typeof materializeAppSprinkles>[2]
    );
    return written.length;
  } catch (e) {
    log.warn('mcp: failed to materialize app sprinkles', {
      name,
      error: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}

export type { McpAppDef };
// Re-export for tests that need to verify content shape without
// reaching into private symbols.
export { aliasContent, formatTable };
