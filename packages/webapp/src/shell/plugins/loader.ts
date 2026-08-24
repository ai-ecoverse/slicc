/**
 * Agent Plugins loader — loads and validates a plugin package directory per
 * the Agent Plugins Specification v1.0.0 (agent-plugins.org).
 *
 * Conformance profile: skills + MCP servers (`streamable-http` only — slicc
 * is browser-first, so `stdio` cannot be launched and legacy `sse` is not
 * implemented; both are skipped per §7.2.2 rules 3–4). Manifest validation
 * follows the closed schema in §5 with the non-fatal exceptions of §5.2 and
 * §8.1; component failures are isolated per §11.3.
 */

import { isLoopbackHostname } from '@slicc/shared-ts';
import type { VirtualFS } from '../../fs/index.js';
import {
  type LoadedPlugin,
  PLUGIN_MANIFEST_SCHEMA_ID,
  PLUGIN_MCP_SCHEMA_ID,
  type PluginDiagnostic,
  type PluginLoadResult,
  type PluginManifest,
  type PluginMcpComponent,
  type PluginMcpServer,
  type PluginSkill,
} from './types.js';

const MANIFEST_FILE = 'plugin.json';
const SKILLS_DIR = 'skills';
const MCP_FILE = 'mcp.json';
const SKILL_FILE = 'SKILL.md';

/** Opaque JSON object mid-parse; fields are narrowed by the validators below. */
type JsonObject = { [key: string]: unknown };

const MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const AUTHOR_FIELDS = new Set(['name', 'email', 'url']);

/** §5.5 — 1-64 chars of [a-z0-9.-], alphanumeric ends, no `--` / `..`. */
export function isValidPluginName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return false;
  if (name.includes('--') || name.includes('..')) return false;
  return true;
}

/**
 * Load a plugin from `rootPath`. Never throws: a rejected plugin returns
 * `{ ok: false }` with diagnostics explaining the fatal violation.
 */
export async function loadPluginFromDirectory(
  fs: VirtualFS,
  rootPath: string
): Promise<PluginLoadResult> {
  const diagnostics: PluginDiagnostic[] = [];
  const root = normalizeRoot(rootPath);

  const rootStat = await statOrNull(fs, root);
  if (rootStat?.type !== 'directory') {
    diagnostics.push(fatal('manifest', `plugin root is not a directory: ${root}`));
    return { ok: false, diagnostics };
  }

  const manifest = await loadManifest(fs, root, diagnostics);
  if (!manifest) return { ok: false, diagnostics };

  // §11.3: component failures are isolated — skills and MCP load independently.
  const skills = await discoverPluginSkills(fs, root, diagnostics);
  const mcp = await loadMcpComponent(fs, root, diagnostics);

  const plugin: LoadedPlugin = { root, manifest, skills, mcp };
  return { ok: true, plugin, diagnostics };
}

// ── manifest (§5) ───────────────────────────────────────────────────

async function loadManifest(
  fs: VirtualFS,
  root: string,
  diagnostics: PluginDiagnostic[]
): Promise<PluginManifest | null> {
  const manifestPath = `${root}/${MANIFEST_FILE}`;
  const stat = await statOrNull(fs, manifestPath);
  if (stat?.type !== 'file') {
    diagnostics.push(fatal('manifest', `missing ${MANIFEST_FILE} at plugin root`));
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readTextFile(manifestPath));
  } catch (e) {
    diagnostics.push(
      fatal('manifest', `plugin.json is not valid JSON: ${e instanceof Error ? e.message : e}`)
    );
    return null;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    diagnostics.push(fatal('manifest', 'plugin.json must contain a top-level object'));
    return null;
  }
  const obj = raw as JsonObject;

  // §5.2: unknown top-level fields are reported and ignored (non-fatal).
  for (const key of Object.keys(obj)) {
    if (!MANIFEST_FIELDS.has(key)) {
      diagnostics.push(warn('manifest', `unknown field "${key}" ignored`));
      delete obj[key];
    }
  }

  // §5.3: required fields — missing/invalid is fatal.
  if (typeof obj.$schema !== 'string' || obj.$schema.length === 0) {
    diagnostics.push(fatal('manifest', 'required field "$schema" is missing or not a string'));
    return null;
  }
  if (obj.$schema !== PLUGIN_MANIFEST_SCHEMA_ID) {
    diagnostics.push(
      fatal('manifest', `unsupported Agent Plugins version: ${obj.$schema} (supported: 1.0.0)`)
    );
    return null;
  }
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    diagnostics.push(fatal('manifest', 'required field "name" is missing or not a string'));
    return null;
  }
  if (!isValidPluginName(obj.name)) {
    diagnostics.push(fatal('manifest', `invalid plugin name "${obj.name}" (§5.5)`));
    return null;
  }

  return validateMetadataFields(obj, diagnostics);
}

/**
 * §5.4 metadata typing + §8.1 extensions handling. Any type violation other
 * than a non-object `extensions` is fatal (returns null).
 */
function validateMetadataFields(
  obj: JsonObject,
  diagnostics: PluginDiagnostic[]
): PluginManifest | null {
  const typeError = findMetadataTypeError(obj);
  if (typeError) {
    diagnostics.push(fatal('manifest', typeError));
    return null;
  }
  if ('extensions' in obj) {
    const ext = obj.extensions;
    // §8.1: a non-object `extensions` is reported and ignored (non-fatal).
    if (typeof ext !== 'object' || ext === null || Array.isArray(ext)) {
      diagnostics.push(warn('manifest', 'field "extensions" is not an object; ignored'));
      delete obj.extensions;
    } else {
      const nsError = findExtensionsError(ext as JsonObject);
      if (nsError) {
        diagnostics.push(fatal('manifest', nsError));
        return null;
      }
      // §8.1 / §11.1: slicc implements no extension namespaces — entries are
      // preserved opaquely without validating their contents.
    }
  }
  return obj as unknown as PluginManifest;
}

/** Returns an error message for the first §5.4 metadata type violation. */
function findMetadataTypeError(obj: JsonObject): string | null {
  for (const field of ['version', 'description', 'homepage', 'repository', 'license'] as const) {
    if (field in obj && typeof obj[field] !== 'string') {
      return `field "${field}" must be a string`;
    }
  }
  if ('keywords' in obj) {
    const kw = obj.keywords;
    if (!Array.isArray(kw) || kw.some((k) => typeof k !== 'string')) {
      return 'field "keywords" must be an array of strings';
    }
  }
  if ('author' in obj) {
    const author = obj.author;
    if (typeof author !== 'object' || author === null || Array.isArray(author)) {
      return 'field "author" must be an object';
    }
    for (const [key, value] of Object.entries(author as JsonObject)) {
      if (!AUTHOR_FIELDS.has(key) || typeof value !== 'string') {
        return `invalid "author" field "${key}"`;
      }
    }
  }
  return null;
}

/** Returns an error message when an extensions namespace value is not an object. */
function findExtensionsError(ext: JsonObject): string | null {
  for (const [ns, value] of Object.entries(ext)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `extensions namespace "${ns}" must map to an object`;
    }
  }
  return null;
}

// ── skills (§6.1 + §7.1) ────────────────────────────────────────────

async function discoverPluginSkills(
  fs: VirtualFS,
  root: string,
  diagnostics: PluginDiagnostic[]
): Promise<PluginSkill[]> {
  const skillsRoot = `${root}/${SKILLS_DIR}`;
  const stat = await statOrNull(fs, skillsRoot);
  // §6.2: absent fixed location is not an error.
  if (!stat) return [];
  if (stat.type !== 'directory') {
    diagnostics.push(warn('skills', '"skills" exists but is not a directory; component skipped'));
    return [];
  }

  let entries: Array<{ name: string; type: string }>;
  try {
    entries = await fs.readDir(skillsRoot);
  } catch (e) {
    diagnostics.push(warn('skills', `cannot read skills/: ${e instanceof Error ? e.message : e}`));
    return [];
  }

  const skills: PluginSkill[] = [];
  // §7.1: only immediate child directories with a regular SKILL.md count.
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.type !== 'directory') continue;
    const skillPath = `${skillsRoot}/${entry.name}`;
    const skillFilePath = `${skillPath}/${SKILL_FILE}`;
    const skillStat = await statOrNull(fs, skillFilePath);
    if (skillStat?.type !== 'file') continue;

    try {
      const content = await fs.readTextFile(skillFilePath);
      const frontmatter = parseSkillFrontmatter(content);
      // Agent Skills spec: name + description frontmatter are required.
      if (!frontmatter.name || !frontmatter.description) {
        diagnostics.push(
          warn('skills', `skill "${entry.name}" skipped: SKILL.md missing name/description`)
        );
        continue;
      }
      skills.push({
        name: entry.name,
        path: skillPath,
        skillFilePath,
        description: frontmatter.description,
      });
    } catch (e) {
      diagnostics.push(
        warn('skills', `skill "${entry.name}" skipped: ${e instanceof Error ? e.message : e}`)
      );
    }
  }
  return skills;
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trimStart();
  const fm = normalized.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const out: { name?: string; description?: string } = {};
  const lines = fm[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!m) continue;
    const rawValue = m[2].trim();
    // YAML block scalar (`>` folded / `|` literal, with optional chomping
    // indicator): collect the indented continuation lines.
    const block = rawValue.match(/^([>|])[+-]?$/);
    const value = block
      ? collectBlockScalar(lines, i + 1, block[1] === '>' ? ' ' : '\n')
      : unquoteScalar(rawValue);
    if (m[1] === 'name') out.name = value;
    else out.description = value;
  }
  return out;
}

/** Strip one matching pair of surrounding quotes (never a lone quote). */
function unquoteScalar(value: string): string {
  const q = value[0];
  if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
    const inner = value.slice(1, -1);
    return q === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'");
  }
  return value;
}

/** Join the indented continuation lines of a YAML block scalar. */
function collectBlockScalar(lines: string[], start: number, separator: string): string {
  const collected: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    collected.push(line.trim());
  }
  return collected.join(separator);
}

// ── MCP servers (§7.2) ──────────────────────────────────────────────

async function loadMcpComponent(
  fs: VirtualFS,
  root: string,
  diagnostics: PluginDiagnostic[]
): Promise<PluginMcpComponent> {
  const mcpPath = `${root}/${MCP_FILE}`;
  const stat = await statOrNull(fs, mcpPath);
  if (!stat) return { status: 'absent', servers: [] };
  if (stat.type !== 'file') {
    diagnostics.push(warn('mcp', '"mcp.json" exists but is not a regular file; MCP disabled'));
    return { status: 'invalid', servers: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readTextFile(mcpPath));
  } catch (e) {
    diagnostics.push(
      warn('mcp', `mcp.json is not valid JSON: ${e instanceof Error ? e.message : e}; MCP disabled`)
    );
    return { status: 'invalid', servers: [] };
  }

  // §7.2.1: closed top-level — exactly $schema + mcpServers.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    diagnostics.push(warn('mcp', 'mcp.json must contain a top-level object; MCP disabled'));
    return { status: 'invalid', servers: [] };
  }
  const obj = raw as JsonObject;
  const extraKeys = Object.keys(obj).filter((k) => k !== '$schema' && k !== 'mcpServers');
  if (extraKeys.length > 0) {
    diagnostics.push(
      warn(
        'mcp',
        `mcp.json has unexpected top-level fields (${extraKeys.join(', ')}); MCP disabled`
      )
    );
    return { status: 'invalid', servers: [] };
  }
  if (obj.$schema !== PLUGIN_MCP_SCHEMA_ID) {
    // §10.1: mcp.json's version must match plugin.json's (both 1.0.0 here).
    diagnostics.push(
      warn('mcp', `mcp.json $schema is missing or targets an unsupported version; MCP disabled`)
    );
    return { status: 'invalid', servers: [] };
  }
  const servers = obj.mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    diagnostics.push(warn('mcp', 'mcp.json "mcpServers" must be an object; MCP disabled'));
    return { status: 'invalid', servers: [] };
  }

  const results: PluginMcpServer[] = [];
  for (const [name, entry] of Object.entries(servers as JsonObject)) {
    const server = validateMcpServer(name, entry);
    if (server.status !== 'supported') {
      diagnostics.push(warn('mcp', `server "${name}" skipped: ${server.reason}`));
    }
    results.push(server);
  }
  return { status: 'loaded', servers: results };
}

const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);
const REMOTE_FIELDS = new Set(['type', 'url', 'headers']);

/** §7.2.1 closed variants + §7.2.2 per-server failure isolation. */
function validateMcpServer(name: string, entry: unknown): PluginMcpServer {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { name, status: 'invalid', reason: 'server entry must be an object' };
  }
  const obj = entry as JsonObject;
  const type = obj.type;

  if (type === 'stdio') {
    const unknown = Object.keys(obj).filter((k) => !STDIO_FIELDS.has(k));
    if (unknown.length > 0) {
      return { name, status: 'invalid', reason: `unknown field(s): ${unknown.join(', ')}` };
    }
    if (typeof obj.command !== 'string' || obj.command.length === 0) {
      return { name, status: 'invalid', reason: '"command" must be a non-empty string' };
    }
    // §7.2.2 rule 4: valid entry, transport unsupported in the browser.
    return {
      name,
      status: 'unsupported-transport',
      reason: 'stdio transport is unsupported (slicc cannot launch subprocesses in the browser)',
    };
  }

  if (type === 'streamable-http' || type === 'sse') {
    const unknown = Object.keys(obj).filter((k) => !REMOTE_FIELDS.has(k));
    if (unknown.length > 0) {
      return { name, status: 'invalid', reason: `unknown field(s): ${unknown.join(', ')}` };
    }
    const urlError = validateRemoteUrl(obj.url);
    if (urlError) return { name, status: 'invalid', reason: urlError };
    const headersError = validateHeaders(obj.headers);
    if (headersError) return { name, status: 'invalid', reason: headersError };

    if (type === 'sse') {
      // §7.2.1 transport support: sse is OPTIONAL; slicc implements
      // streamable-http only (the single-transport allowance in §11.1.5).
      return {
        name,
        status: 'unsupported-transport',
        reason: 'legacy HTTP+SSE transport is unsupported (streamable-http only)',
      };
    }
    return {
      name,
      status: 'supported',
      config: {
        type,
        url: obj.url as string,
        ...(obj.headers ? { headers: obj.headers as Record<string, string> } : {}),
      },
    };
  }

  return { name, status: 'invalid', reason: `unknown transport type "${String(type)}"` };
}

function validateRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return '"url" must be a string';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"url" is not an absolute URL: ${raw}`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `"url" must be HTTP or HTTPS: ${raw}`;
  }
  if (url.username || url.password) return '"url" must not contain user information';
  if (url.hash) return '"url" must not contain a fragment';
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    return 'non-loopback endpoints must use HTTPS';
  }
  return null;
}

function validateHeaders(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return '"headers" must be an object of strings';
  }
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(raw as JsonObject)) {
    if (typeof value !== 'string') return `header "${key}" must have a string value`;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) return `invalid header name "${key}"`;
    const lower = key.toLowerCase();
    if (seen.has(lower)) return `duplicate header name "${key}" (case-insensitive)`;
    seen.add(lower);
  }
  return null;
}

// ── shared helpers ──────────────────────────────────────────────────

function normalizeRoot(rootPath: string): string {
  const collapsed = rootPath.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

function fatal(component: PluginDiagnostic['component'], message: string): PluginDiagnostic {
  return { level: 'error', component, message };
}

function warn(component: PluginDiagnostic['component'], message: string): PluginDiagnostic {
  return { level: 'warning', component, message };
}

async function statOrNull(fs: VirtualFS, path: string): Promise<{ type: string } | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}
