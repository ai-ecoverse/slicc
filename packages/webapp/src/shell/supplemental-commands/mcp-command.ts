import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../base/logger.js';
import type { VirtualFS } from '../../fs/index.js';
import type { OAuthLauncher } from '../../providers/types.js';
import { resolveFloatTopology } from '../float-topology.js';
import { McpTimeoutError } from '../mcp/client.js';
import type { FetchLike } from '../mcp/oauth.js';
import { resolveMcpRedirectUri } from '../mcp/redirect-uri.js';
import type {
  McpAppDef,
  McpExposureMode,
  McpFetchLike,
  McpServerEntry,
  McpToolDef,
} from '../mcp/types.js';
import type { ScriptCatalog } from '../script-catalog.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

const MCP_AUTH_BOOL_FLAGS = ['--silent', '-s', '--interactive', '-i'] as const;

const EXPOSURE_MODES: ReadonlySet<string> = new Set([
  'codemode',
  'codemode-deferred',
  'deferred',
  'direct',
  'hidden',
]);

const log = createLogger('mcp-command');

export interface McpCommandDeps {
  fetchImpl?: McpFetchLike;

  oauthFetchImpl?: FetchLike;

  oauthLauncher?: OAuthLauncher;

  fs?: VirtualFS;

  scriptCatalog?: ScriptCatalog;

  connectionManager?: import('../mcp/connection-manager.js').McpConnectionManager;
}

const VALID_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function isValidServerName(name: string): boolean {
  return VALID_NAME_RE.test(name);
}

function isTimeoutLikeError(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false;
  return e.name === 'TimeoutError' || e.name === 'AbortError';
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

function flagError(message: string): ExecResult {
  return err(`mcp: ${message}`);
}

interface ImportedMcpServerDef {
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
}

interface ImportedMcpConfig {
  mcpServers?: Record<string, ImportedMcpServerDef>;
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
  exposure <name> <mode>     Set exposure mode for a server or tool.
  import <file>              Import servers from a Pi/Claude/Cursor config.

Examples:
  mcp add https://mcp.example.com/sse weather
  mcp list
  mcp list --json
  mcp invoke weather get-forecast --lat 51.5 --lon -0.12
  mcp invoke weather get-forecast --json
  mcp search forecast
  mcp exposure weather direct
  mcp exposure weather codemode --tool 'delete_*'
  mcp import claude_desktop_config.json
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
        case 'exposure':
          return await cmdExposure(rest, deps);
        case 'import':
          return await cmdImport(rest, deps);
        default:
          return err(`mcp: unknown subcommand "${sub}" (try \`mcp --help\`)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('mcp subcommand failed', { sub, error: msg });
      if (e instanceof McpTimeoutError) return err(`mcp ${sub}: ${msg}`, 124);
      if (isTimeoutLikeError(e)) return err(`mcp ${sub}: ${msg}`, 124);
      return err(`mcp ${sub}: ${msg}`);
    }
  });
}

async function cmdAdd(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (isHelpRequest(args)) {
    return ok(`usage: mcp add <url> <name> [--exposure <mode>]

Probes <url> with an unauthenticated MCP \`initialize\`. If the server
returns 401, runs OAuth discovery → dynamic client registration → PKCE
authorization-code flow, stores the access token, and retries.

On success, the server is persisted to /workspace/.mcp/servers.json and
an alias shim is written to /workspace/.mcp/aliases/<name>.jsh so the
short name resolves on the PATH.

Options:
  --exposure <mode>   Set the default exposure mode for all tools on this
                      server. Modes: codemode (default), codemode-deferred,
                      deferred, direct, hidden.
`);
  }
  const parsed = parseKnownFlags(args, { value: ['--exposure'] });
  if ('error' in parsed) return flagError(parsed.error);
  if (parsed.positionals.length < 2) {
    return err('mcp add: expected <url> <name>');
  }
  const [url, name] = parsed.positionals;
  const exposureRaw = parsed.values.get('--exposure');
  if (exposureRaw && !EXPOSURE_MODES.has(exposureRaw)) {
    return err(
      `mcp add: invalid exposure mode "${exposureRaw}" (valid: ${[...EXPOSURE_MODES].join(', ')})`
    );
  }
  const exposure = exposureRaw as McpExposureMode | undefined;
  if (!/^https?:\/\//i.test(url)) {
    return err(`mcp add: invalid URL "${url}" (must start with http:// or https://)`);
  }
  if (!isValidServerName(name)) {
    return err(
      `mcp add: invalid name "${name}" (letters, digits, _ and - only; must start with a letter)`
    );
  }

  const { getServer, setServer } = await import('../mcp/store.js');
  const existing = await getServer(name, deps.fs);
  if (existing) {
    return err(`mcp add: a server named "${name}" already exists`);
  }

  const { McpClient, McpAuthRequiredError } = await import('../mcp/client.js');
  let client = new McpClient({ url, fetchImpl: deps.fetchImpl });
  let authBlock: McpServerEntry['auth'];

  try {
    await client.initialize();
  } catch (e) {
    if (!(e instanceof McpAuthRequiredError)) throw e;

    authBlock = await runOAuthForAdd(url, name, e.resourceMetadataUrl, deps);

    client = new McpClient({
      url,
      fetchImpl: deps.fetchImpl,
      getAuthHeader: () => getMcpBearerHeader(name),
    });
    await client.initialize();
  }

  const tools = await client.toolsList();
  const apps = await client.appsList();

  const now = new Date().toISOString();

  const entry: McpServerEntry = {
    url,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    tools,
    apps,
    addedAt: now,
    lastRefreshedAt: now,
    ...(authBlock ? { auth: authBlock } : {}),
    ...(exposure ? { exposure } : {}),
  };
  await setServer(name, entry, deps.fs);

  await writeAliasShim(name, deps);

  const sprinkles = await materializeAppSprinklesSafe(name, apps, deps);

  if (authBlock) {
    const { registerMcpProvider } = await import('../mcp/provider.js');
    registerMcpProvider({ name, serverUrl: url, auth: authBlock });
  }

  if (deps.connectionManager) {
    await deps.connectionManager.connect(name, entry);
  }

  const lines = [
    `Added MCP server "${name}" → ${url}`,
    `  tools: ${tools.length}, apps: ${apps.length} (${sprinkles} sprinkle${sprinkles === 1 ? '' : 's'})`,
    `  alias: ${ALIASES_DIR}/${name}.jsh`,
    authBlock ? `  auth:  oauth (provider mcp:${name})` : '  auth:  none',
    exposure ? `  exposure: ${exposure}` : '  exposure: codemode (default)',
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
  const { saveOAuthAccount } = await import('../../providers/account-store.js');
  const fetchImpl = await resolveOAuthFetchImpl(deps.oauthFetchImpl);
  const launcher = deps.oauthLauncher ?? (await defaultLauncher());

  const asMetadata = await discoverAuth(serverUrl, resourceMetadataUrl, fetchImpl);
  log.debug('MCP OAuth discovery succeeded', {
    name,
    serverUrl,
    discoveryPath: asMetadata.discoveryPath,
    issuer: asMetadata.issuer,
  });
  const redirectUri = await resolveMcpRedirectUri(resolveFloatTopology());
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
    scopes: token.scope,
  });

  return {
    providerId,
    authorizationServer: asMetadata.issuer,
    clientId: dcr.clientId,
    redirectUri,
    scope: token.scope ?? scope,
    registrationClientUri: dcr.registrationClientUri,
  };
}

async function cmdList(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (isHelpRequest(args)) {
    return ok(`usage: mcp list [--json]

Lists configured MCP servers with connection state, exposure mode,
transport type, and tool counts.

Options:
  --json   Output as JSON instead of a table.
`);
  }
  const parsed = parseKnownFlags(args, { bool: ['--json'] });
  if ('error' in parsed) return flagError(parsed.error);
  const jsonOutput = parsed.bools.has('--json');
  const { ensureAllMcpProvidersRegistered } = await import('../mcp/provider.js');
  await ensureAllMcpProvidersRegistered();
  const { listServers } = await import('../mcp/store.js');
  const servers = await listServers(deps.fs);
  const names = Object.keys(servers).sort();
  if (names.length === 0) {
    if (jsonOutput) return ok('[]\n');
    return ok('No MCP servers configured. Use `mcp add <url> <name>`.\n');
  }

  if (jsonOutput) {
    const entries = names.map((n) => {
      const e = servers[n];
      return {
        name: n,
        url: e.url,
        state: deps.connectionManager?.has(n) ? 'connected' : 'disconnected',
        exposure: e.exposure ?? 'codemode',
        transport: e.transport ?? 'unknown',
        auth: !!e.auth,
        tools: e.tools?.length ?? 0,
        apps: e.apps?.length ?? 0,
        addedAt: e.addedAt ?? null,
      };
    });
    return ok(JSON.stringify(entries, null, 2) + '\n');
  }

  const rows = [
    ['NAME', 'URL', 'STATE', 'EXPOSURE', 'TRANSPORT', 'AUTH', 'TOOLS', 'APPS', 'ADDED'],
  ];
  for (const n of names) {
    const e = servers[n];
    rows.push([
      n,
      e.url,
      deps.connectionManager?.has(n) ? 'connected' : '-',
      e.exposure ?? 'codemode',
      e.transport ?? '-',
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

async function cmdSearch(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (isHelpRequest(args)) {
    return ok(`usage: mcp search <query>

Case-insensitive substring search across the cached tools of every
registered MCP server. Matches tool name OR description and prints a
table of (server, tool, description, match-field) rows.
`);
  }
  const parsed = parseKnownFlags(args, {});
  if ('error' in parsed) return flagError(parsed.error);
  if (parsed.positionals.length === 0) {
    return err('mcp search: expected <query>');
  }
  const query = parsed.positionals[0];
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

async function cmdDelete(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args.length === 0 || isHelpRequest(args)) {
    return args.length === 0
      ? err('mcp delete: expected <name>')
      : ok('usage: mcp delete <name>\n');
  }
  const parsed = parseKnownFlags(args, {});
  if ('error' in parsed) return flagError(parsed.error);
  const name = parsed.positionals[0];
  if (!name) {
    return err('mcp delete: expected <name>');
  }
  const { ensureMcpProviderRegistered, removeMcpProvider } = await import('../mcp/provider.js');
  await ensureMcpProviderRegistered(name);
  const { deleteServer } = await import('../mcp/store.js');
  const removedServer = await deleteServer(name, deps.fs);

  if (deps.connectionManager) {
    await deps.connectionManager.disconnect(name);
  }

  await removeAliasShim(name, deps);
  await removeSprinklesDir(name, deps);

  const providerId = `mcp:${name}`;
  let oauthRemoved = false;
  try {
    const { removeAccount, getAccounts } = await import('../../providers/account-store.js');
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

async function cmdInvoke(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args.length === 0) {
    return err('mcp invoke: expected <name>');
  }
  if (isHelpRequest(args.slice(0, 1))) {
    return ok(invokeHelpText());
  }
  const head = parseKnownFlags([args[0]], {});
  if ('error' in head) return flagError(head.error);
  const name = head.positionals[0];
  if (!name) {
    return err('mcp invoke: expected <name>');
  }
  const rest = args.slice(1);

  const { ensureMcpProviderRegistered } = await import('../mcp/provider.js');
  await ensureMcpProviderRegistered(name);

  const { getServer } = await import('../mcp/store.js');
  const entry = await getServer(name, deps.fs);
  if (!entry) {
    return err(`mcp invoke: unknown server "${name}" (run \`mcp add <url> ${name}\` first)`);
  }

  const tools = entry.tools ?? [];

  if (rest.length === 0 || isHelpRequest(rest.slice(0, 1))) {
    return ok(formatServerHelp(name, entry, tools));
  }

  const toolHead = parseKnownFlags([rest[0]], {});
  if ('error' in toolHead) return flagError(toolHead.error);
  const toolName = toolHead.positionals[0];
  if (!toolName) {
    return err('mcp invoke: expected <tool>');
  }
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return err(
      `mcp invoke: unknown tool "${toolName}" on "${name}" (run \`${name}\` to list tools)`
    );
  }

  const toolArgs = rest.slice(1);

  const { timeoutMs, remaining: filteredArgs, warnings } = extractTimeoutFlag(toolArgs);

  if (isHelpRequest(filteredArgs)) {
    return ok(formatToolHelp(name, tool));
  }

  const { jsonFlag, remaining: afterJson } = extractJsonFlag(filteredArgs);
  const coerced = coerceArgsBySchema(afterJson, tool.inputSchema);
  if (!coerced.ok) return err(`mcp invoke: ${coerced.error}`);

  let result: unknown;
  if (deps.connectionManager) {
    const { connection } = await deps.connectionManager.connect(name, entry);
    const signal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
    result = await connection.callTool(toolName, coerced.value, { signal });
  } else {
    const { McpClient } = await import('../mcp/client.js');
    const client = new McpClient({
      url: entry.url,
      fetchImpl: deps.fetchImpl,
      headers: entry.headers,
      getAuthHeader: entry.auth ? () => getMcpBearerHeader(name) : undefined,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    await client.initialize();
    result = await client.toolsCall(toolName, coerced.value);
  }

  if (jsonFlag) {
    return ok(JSON.stringify(result, null, 2) + '\n');
  }
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

function extractJsonFlag(args: string[]): { jsonFlag: boolean; remaining: string[] } {
  const remaining: string[] = [];
  let jsonFlag = false;
  for (const a of args) {
    if (a === '--json') {
      jsonFlag = true;
    } else {
      remaining.push(a);
    }
  }
  return { jsonFlag, remaining };
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
  return `usage: mcp invoke <name> [tool] [--timeout <seconds>] [--json] [--flag value …]

  mcp invoke <name>                   List tools on <name>.
  mcp invoke <name> <tool> --help     Show flags for <tool>.
  mcp invoke <name> <tool> --foo bar  Call <tool> with arguments.

Slicc-level options (consumed before tool args):
  --timeout <seconds>   Override the per-request timeout (default 60s).
                        Must be a positive integer; invalid values warn
                        on stderr and fall back to the default.
                        A timeout exits with code 124 (matching GNU
                        timeout(1)) so scripts can branch on it.
  --json                Print the raw CallToolResult as JSON instead of
                        the rendered text output.

Arguments are coerced according to the tool's JSON Schema:
  string/integer/number/boolean. Bare \`--flag\` (no value or "--" next)
  is treated as true. Repeating a flag accumulates into an array when
  the schema declares \`type: array\`. A \`type: object\` flag (and an
  array of objects) is parsed as JSON, e.g. \`--params '{"url":"…"}'\`.
  Nested fields can be set with dotted flags (\`--params.url …\`).
  Unknown \`--flags\` exit non-zero instead of being dropped.
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

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  items?: { type?: string };
}

interface JsonSchemaObject {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

type McpArgValue = string | number | boolean | null | McpArgValue[] | McpArgObject;

interface McpArgObject {
  [key: string]: McpArgValue;
}

type McpToolArguments = McpArgObject;

function asSchemaObject(schema: unknown): JsonSchemaObject {
  return (schema ?? {}) as JsonSchemaObject;
}

function formatToolHelp(name: string, tool: McpToolDef): string {
  const schema = asSchemaObject(tool.inputSchema);
  const properties = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
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
    const type = properties[p]?.type ?? 'string';
    return `  --${p} <${type}>`;
  });
  const width = labels.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < propNames.length; i++) {
    const p = propNames[i];
    const desc = properties[p]?.description ?? '';
    const req = required.has(p) ? ' (required)' : '';
    lines.push(`${labels[i].padEnd(width)}  ${desc}${req}`.trimEnd());
  }
  return lines.join('\n') + '\n';
}

interface CoerceResult {
  ok: true;
  value: McpToolArguments;
}
interface CoerceErr {
  ok: false;
  error: string;
}

export function coerceArgsBySchema(args: string[], schema: unknown): CoerceResult | CoerceErr {
  const s = asSchemaObject(schema);
  const properties = s.properties ?? {};
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const out: McpToolArguments = emptyArgObject();

  let i = 0;
  while (i < args.length) {
    const result = parseOneFlag(args, i, properties, out);
    if (!result.ok) return result;
    i = result.nextIndex;
  }

  for (const r of required) {
    if (!Object.hasOwn(out, r)) {
      return { ok: false, error: `missing required flag --${r}` };
    }
  }
  return { ok: true, value: out };
}

function parseOneFlag(
  args: string[],
  i: number,
  properties: Record<string, JsonSchemaProperty>,
  out: McpToolArguments
): (CoerceErr & { nextIndex?: never }) | { ok: true; nextIndex: number } {
  const a = args[i];
  if (!a.startsWith('--')) {
    return { ok: false, error: `unexpected positional argument "${a}"` };
  }
  const { key, inlineValue } = splitFlag(a);
  const resolved = resolveToolFlag(key, properties);
  if (!resolved.ok) return resolved;

  const { rootKey, dottedPath, meta } = resolved;
  const declaredType = meta.type;
  const type = declaredType ?? 'string';
  const isArray = type === 'array';
  const itemType = (isArray ? meta.items?.type : undefined) ?? 'string';
  if (dottedPath && declaredType !== undefined && declaredType !== 'object') {
    return { ok: false, error: `unknown flag: --${key}` };
  }

  const taken = readFlagRaw(args, i, key, inlineValue, type, dottedPath);
  if (!taken.ok) return taken;
  if (taken.bareBoolean) {
    out[rootKey] = true;
    return { ok: true, nextIndex: taken.nextIndex };
  }

  const valueType = dottedPath ? 'string' : isArray ? itemType : type;
  const coerced = coerceScalar(taken.raw, valueType);
  if (!coerced.ok) return { ok: false, error: `--${key}: ${coerced.error}` };
  const assigned = assignFlagValue(out, rootKey, dottedPath, coerced.value, isArray);
  if (!assigned.ok) return assigned;
  return { ok: true, nextIndex: taken.nextIndex };
}

interface ResolvedToolFlag {
  ok: true;
  rootKey: string;
  dottedPath: string[] | null;
  meta: JsonSchemaProperty;
}

function resolveToolFlag(
  key: string,
  properties: Record<string, JsonSchemaProperty>
): ResolvedToolFlag | CoerceErr {
  if (Object.hasOwn(properties, key)) {
    return { ok: true, rootKey: key, dottedPath: null, meta: properties[key] ?? {} };
  }
  const dot = key.indexOf('.');
  if (dot <= 0) return { ok: false, error: `unknown flag: --${key}` };
  const rootKey = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  if (!Object.hasOwn(properties, rootKey) || rest.length === 0) {
    return { ok: false, error: `unknown flag: --${key}` };
  }
  const parts = rest.split('.');
  if (isUnsafeObjectKey(rootKey) || parts.some((p) => p.length === 0 || isUnsafeObjectKey(p))) {
    return { ok: false, error: `unknown flag: --${key}` };
  }
  return { ok: true, rootKey, dottedPath: parts, meta: properties[rootKey] ?? {} };
}

interface FlagRaw {
  ok: true;
  raw: string;
  nextIndex: number;
  bareBoolean: boolean;
}

function readFlagRaw(
  args: string[],
  i: number,
  key: string,
  inlineValue: string | undefined,
  type: string,
  dottedPath: string[] | null
): FlagRaw | CoerceErr {
  if (inlineValue !== undefined) {
    return { ok: true, raw: inlineValue, nextIndex: i + 1, bareBoolean: false };
  }
  const next = args[i + 1];
  if (!dottedPath && type === 'boolean' && (next === undefined || next.startsWith('--'))) {
    return { ok: true, raw: '', nextIndex: i + 1, bareBoolean: true };
  }
  if (next === undefined) {
    return { ok: false, error: `flag --${key} requires a value` };
  }
  return { ok: true, raw: next, nextIndex: i + 2, bareBoolean: false };
}

function assignFlagValue(
  out: McpToolArguments,
  rootKey: string,
  dottedPath: string[] | null,
  value: McpArgValue,
  isArray: boolean
): CoerceErr | { ok: true } {
  if (dottedPath) return setDotted(out, rootKey, dottedPath, value);
  if (isArray) {
    const prev = out[rootKey];
    if (Array.isArray(prev)) prev.push(value);
    else out[rootKey] = [value];
    return { ok: true };
  }
  const existing = out[rootKey];
  if (isPlainObject(existing) && isPlainObject(value)) {
    Object.assign(existing, value);
    return { ok: true };
  }
  out[rootKey] = value;
  return { ok: true };
}

function setDotted(
  out: McpToolArguments,
  rootKey: string,
  path: string[],
  value: McpArgValue
): CoerceErr | { ok: true } {
  if (isUnsafeObjectKey(rootKey) || path.some((p) => p.length === 0 || isUnsafeObjectKey(p))) {
    return { ok: false, error: `unknown flag: --${rootKey}.${path.join('.')}` };
  }
  const existing = Object.hasOwn(out, rootKey) ? out[rootKey] : undefined;
  if (existing === undefined) {
    out[rootKey] = emptyArgObject();
  } else if (!isPlainObject(existing)) {
    return { ok: false, error: `--${rootKey}: cannot nest into a ${typeof existing} value` };
  }
  let cursor = out[rootKey] as McpArgObject;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const next = Object.hasOwn(cursor, seg) ? cursor[seg] : undefined;
    if (next === undefined) {
      cursor[seg] = emptyArgObject();
    } else if (!isPlainObject(next)) {
      return {
        ok: false,
        error: `--${rootKey}.${path.slice(0, i + 1).join('.')}: cannot nest into a ${typeof next} value`,
      };
    }
    cursor = cursor[seg] as McpArgObject;
  }
  cursor[path[path.length - 1]] = value;
  return { ok: true };
}

function emptyArgObject(): McpArgObject {
  return Object.create(null) as McpArgObject;
}

function isUnsafeObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

function isPlainObject(value: unknown): value is McpArgObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value !== Object.prototype
  );
}

function splitFlag(a: string): { key: string; inlineValue: string | undefined } {
  const eq = a.indexOf('=');
  if (eq > 2) return { key: a.slice(2, eq), inlineValue: a.slice(eq + 1) };
  return { key: a.slice(2), inlineValue: undefined };
}

function coerceScalar(
  raw: string,
  type: string
): { ok: true; value: McpArgValue } | { ok: false; error: string } {
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
    case 'object':
      return coerceJsonObject(raw);
    default:
      return { ok: true, value: raw };
  }
}

function coerceJsonObject(
  raw: string
): { ok: true; value: McpArgObject } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `expected object JSON, got "${raw}"` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: `expected object JSON, got "${raw}"` };
  }
  return { ok: true, value: parsed };
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

async function cmdRefresh(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (args.length === 0 || isHelpRequest(args)) {
    return args.length === 0
      ? err('mcp refresh: expected <name>')
      : ok(
          `usage: mcp refresh <name>

Re-fetches the tool catalog and \`apps/list\` for <name>. Does NOT refresh
OAuth tokens — for OAuth token refresh use \`mcp auth <name>\`.
`
        );
  }
  const parsed = parseKnownFlags(args, {});
  if ('error' in parsed) return flagError(parsed.error);
  const name = parsed.positionals[0];
  if (!name) {
    return err('mcp refresh: expected <name>');
  }
  const { ensureMcpProviderRegistered } = await import('../mcp/provider.js');
  await ensureMcpProviderRegistered(name);

  const { getServer, setServer } = await import('../mcp/store.js');
  const entry = await getServer(name, deps.fs);
  if (!entry) return err(`mcp refresh: unknown server "${name}"`);

  let tools: McpToolDef[];
  let apps: McpAppDef[];
  let protocolVersion = entry.protocolVersion;

  if (deps.connectionManager) {
    const connection = await deps.connectionManager.reconnect(name, entry);
    tools = await connection.listTools();
    apps = (await connection.listApps?.()) ?? [];
  } else {
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
    tools = await client.toolsList();
    apps = await client.appsList();
    protocolVersion = client.getNegotiatedProtocolVersion();
  }
  const merged: McpServerEntry = {
    ...entry,
    protocolVersion,
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

async function cmdAuth(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (isHelpRequest(args)) {
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
  const parsed = parseKnownFlags(args, { bool: MCP_AUTH_BOOL_FLAGS });
  if ('error' in parsed) return flagError(parsed.error);
  const name = parsed.positionals[0];
  if (!name) {
    return err('mcp auth: expected <name>');
  }
  const silent = parsed.bools.has('--silent') || parsed.bools.has('-s');
  const interactive = parsed.bools.has('--interactive') || parsed.bools.has('-i');
  if (silent && interactive) {
    return err('mcp auth: --silent and --interactive are mutually exclusive');
  }

  const { ensureMcpProviderRegistered } = await import('../mcp/provider.js');
  const registered = await ensureMcpProviderRegistered(name, {
    fetchImpl: deps.oauthFetchImpl,
    launcher: deps.oauthLauncher,
  });

  const { getServer } = await import('../mcp/store.js');
  const entry = await getServer(name, deps.fs);
  if (!entry) {
    return err(`mcp auth: unknown server "${name}" (run \`mcp list\` to see configured servers)`);
  }
  if (!entry.auth) {
    return err(`mcp auth: server "${name}" does not use OAuth`);
  }
  if (!registered) {
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

async function cmdExposure(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (isHelpRequest(args) || args.length === 0) {
    return args.length === 0
      ? err('mcp exposure: expected <name> <mode>')
      : ok(`usage: mcp exposure <name> <mode> [--tool <glob>]

Set the exposure mode for an MCP server or individual tools.

Modes: codemode (default), codemode-deferred, deferred, direct, hidden.

Without --tool, sets the server-level default exposure.
With --tool, sets a per-tool override using a glob pattern.

Examples:
  mcp exposure weather direct               Set all weather tools to direct
  mcp exposure weather hidden --tool 'delete_*'  Hide delete tools
  mcp exposure weather codemode --tool '*'   Reset all tool overrides
`);
  }
  const parsed = parseKnownFlags(args, { value: ['--tool'] });
  if ('error' in parsed) return flagError(parsed.error);
  if (parsed.positionals.length < 2) {
    return err('mcp exposure: expected <name> <mode>');
  }
  const [name, modeRaw] = parsed.positionals;
  if (!EXPOSURE_MODES.has(modeRaw)) {
    return err(
      `mcp exposure: invalid mode "${modeRaw}" (valid: ${[...EXPOSURE_MODES].join(', ')})`
    );
  }
  const mode = modeRaw as McpExposureMode;
  const toolGlob = parsed.values.get('--tool');

  const { getServer, setServer } = await import('../mcp/store.js');
  const entry = await getServer(name, deps.fs);
  if (!entry) {
    return err(`mcp exposure: unknown server "${name}"`);
  }

  if (toolGlob) {
    if (toolGlob === '*') {
      entry.toolExposure = { '*': mode };
    } else {
      const overrides = entry.toolExposure ?? {};
      overrides[toolGlob] = mode;
      entry.toolExposure = overrides;
    }
    await setServer(name, entry, deps.fs);
    if (deps.connectionManager) deps.connectionManager.notifyToolsChanged(name);
    return ok(`Set tool exposure for "${toolGlob}" on "${name}" → ${mode}\n`);
  }

  entry.exposure = mode;
  await setServer(name, entry, deps.fs);
  if (deps.connectionManager) deps.connectionManager.notifyToolsChanged(name);
  return ok(`Set server exposure for "${name}" → ${mode}\n`);
}

async function cmdImport(args: string[], deps: McpCommandDeps): Promise<ExecResult> {
  if (isHelpRequest(args) || args.length === 0) {
    return args.length === 0
      ? err('mcp import: expected <file>')
      : ok(`usage: mcp import <file>

Import MCP servers from a Pi, Claude Desktop, or Cursor configuration
file. Reads a JSON object with an \`mcpServers\` key containing server
definitions.

Only \`url\`-based servers are imported. Servers with \`command\` (stdio
transport) are skipped with a warning, since there is no process spawning
in the browser.

Examples:
  mcp import claude_desktop_config.json
  mcp import ~/.config/cursor/mcp.json
`);
  }
  const parsed = parseKnownFlags(args, {});
  if ('error' in parsed) return flagError(parsed.error);
  const filePath = parsed.positionals[0];
  if (!filePath) return err('mcp import: expected <file>');

  const fs = await openGlobalFs(deps.fs);
  let raw: string;
  try {
    raw = (await fs.readFile(filePath, { encoding: 'utf-8' })) as string;
  } catch {
    return err(`mcp import: cannot read "${filePath}"`);
  }

  let config: ImportedMcpConfig;
  try {
    config = JSON.parse(raw) as ImportedMcpConfig;
  } catch {
    return err(`mcp import: "${filePath}" is not valid JSON`);
  }

  const mcpServers = config.mcpServers ?? {};
  const names = Object.keys(mcpServers);
  if (names.length === 0) {
    return err(`mcp import: no mcpServers found in "${filePath}"`);
  }

  const { getServer, setServer } = await import('../mcp/store.js');
  const results: string[] = [];
  let imported = 0;
  let skipped = 0;

  for (const name of names) {
    if (!isValidServerName(name)) {
      results.push(`  skip: "${name}" (invalid name)`);
      skipped++;
      continue;
    }
    const serverDef = mcpServers[name];
    if (serverDef.command) {
      results.push(`  skip: "${name}" (stdio transport — not supported in browser)`);
      skipped++;
      continue;
    }
    const url = serverDef.url as string | undefined;
    if (!url || !/^https?:\/\//i.test(url)) {
      results.push(`  skip: "${name}" (no valid URL)`);
      skipped++;
      continue;
    }
    const existing = await getServer(name, deps.fs);
    if (existing) {
      results.push(`  skip: "${name}" (already exists)`);
      skipped++;
      continue;
    }
    const entry: McpServerEntry = {
      url,
      addedAt: new Date().toISOString(),
      ...(serverDef.headers ? { headers: serverDef.headers as Record<string, string> } : {}),
    };
    await setServer(name, entry, deps.fs);
    await writeAliasShim(name, deps);
    results.push(`  added: "${name}" → ${url}`);
    imported++;
  }

  return ok(
    [`Imported from "${filePath}": ${imported} added, ${skipped} skipped`, ...results].join('\n') +
      '\n'
  );
}

async function getMcpBearerHeader(name: string): Promise<string | null> {
  const providerId = `mcp:${name}`;
  const { getOAuthAccountInfo } = await import('../../providers/account-store.js');
  const info = getOAuthAccountInfo(providerId);
  if (!info) return null;
  if (info.expired) {
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
const { promisify } = require('util');
const { exec } = require('child_process');
const argv = Array.isArray(process.argv) ? process.argv.slice(2) : [];
const escape = (s) => {
  const v = String(s);
  if (v === '') return "''";
  if (/^[A-Za-z0-9_\\-+.,:\\/=@%]+$/.test(v)) return v;
  return "'" + v.replace(/'/g, "'\\\\''") + "'";
};
const cmd = ['mcp', 'invoke', ${JSON.stringify(name)}, ...argv.map(escape)].join(' ');
let stdout = '';
let stderr = '';
let exitCode = 0;
try {
  const r = await promisify(exec)(cmd);
  stdout = r.stdout;
  stderr = r.stderr;
} catch (err) {
  // promisify(exec) rejects on a non-zero exit; the rejection carries the
  // captured output plus the child's exit status on \`err.code\`.
  stdout = err?.stdout ?? '';
  stderr = err?.stderr ?? String(err?.message ?? err);
  exitCode = typeof err?.code === 'number' ? err.code : 1;
}
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(exitCode);
`;
}

async function writeAliasShim(name: string, deps: McpCommandDeps): Promise<void> {
  const fs = await openGlobalFs(deps.fs);
  await fs.mkdir(ALIASES_DIR, { recursive: true });
  await fs.writeFile(`${ALIASES_DIR}/${name}.jsh`, aliasContent(name));

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

export { aliasContent, formatTable };
