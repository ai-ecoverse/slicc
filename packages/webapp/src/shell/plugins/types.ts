/**
 * Shared types for the Agent Plugins loader (agent-plugins.org spec v1.0.0).
 *
 * The loader (`loader.ts`), the installed-plugin registry (`store.ts`), and
 * the `plugin` supplemental command all import from here so the manifest and
 * mcp.json shapes stay in one place.
 */

/** Canonical `$schema` identifier for plugin.json (Agent Plugins 1.0.0). */
export const PLUGIN_MANIFEST_SCHEMA_ID =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

/** Canonical `$schema` identifier for mcp.json (Agent Plugins 1.0.0). */
export const PLUGIN_MCP_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/**
 * Opaque payload inside one extensions namespace (§8.1).
 * SLICC preserves unimplemented namespaces without validating their contents.
 */
export interface PluginExtensionNamespacePayload {
  [field: string]: unknown;
}

/** Client-extension namespaces keyed by namespace id (§8.1). */
export type PluginManifestExtensions = Record<string, PluginExtensionNamespacePayload>;

/** Validated plugin.json manifest (closed schema, §5). */
export interface PluginManifest {
  $schema: string;
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /** Client-extension namespaces we do not implement are preserved opaquely. */
  extensions?: PluginManifestExtensions;
}

/** One diagnostic emitted while loading a plugin (§11.3 reporting). */
export interface PluginDiagnostic {
  level: 'error' | 'warning' | 'info';
  /** Which part of the package produced the diagnostic. */
  component: 'manifest' | 'skills' | 'mcp';
  message: string;
}

/** A skill discovered at the fixed `skills/` location (§7.1). */
export interface PluginSkill {
  /** Immediate child directory name under `skills/`. */
  name: string;
  /** Absolute VFS path to the skill directory. */
  path: string;
  /** Absolute VFS path to the SKILL.md file. */
  skillFilePath: string;
  /** `description` from SKILL.md frontmatter when present. */
  description: string;
}

/** Remote MCP server config (streamable-http / legacy sse variants, §7.2.1). */
export interface PluginRemoteMcpConfig {
  type: 'streamable-http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

/** One `mcpServers` entry after per-server validation (§7.2.2). */
export interface PluginMcpServer {
  /** Member name inside `mcpServers`. */
  name: string;
  status: 'supported' | 'unsupported-transport' | 'invalid';
  /** Present only when status is `supported`. */
  config?: PluginRemoteMcpConfig;
  /** Human-readable reason for skipped/invalid entries. */
  reason?: string;
}

/** mcp.json component state after loading (§6.2 + §7.2.2). */
export interface PluginMcpComponent {
  /** absent: no mcp.json; invalid: file present but rejected as a whole. */
  status: 'absent' | 'invalid' | 'loaded';
  servers: PluginMcpServer[];
}

/** A fully loaded plugin package. */
export interface LoadedPlugin {
  /** Absolute VFS path of the plugin root. */
  root: string;
  manifest: PluginManifest;
  skills: PluginSkill[];
  mcp: PluginMcpComponent;
}

/** Loader outcome: rejected plugins carry only diagnostics (§5.2 / §5.3). */
export type PluginLoadResult =
  | { ok: true; plugin: LoadedPlugin; diagnostics: PluginDiagnostic[] }
  | { ok: false; diagnostics: PluginDiagnostic[] };

/** One installed plugin recorded in `/workspace/.plugins/plugins.json`. */
export interface InstalledPluginEntry {
  /** Absolute VFS path of the plugin root at install time. */
  root: string;
  version?: string;
  description?: string;
  installedAt?: string;
  /** MCP store names registered on behalf of this plugin (for cleanup). */
  mcpServerNames?: string[];
  /** GitHub origin (`owner/repo[@branch][/dir]`) for downloaded plugins. */
  source?: string;
}

/** On-disk shape for `/workspace/.plugins/plugins.json`. */
export interface PluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry>;
}
