export const PLUGIN_MANIFEST_SCHEMA_ID =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

export const PLUGIN_MCP_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

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

  // biome-ignore lint/plugin: §8.1 extension namespaces are intentionally opaque — preserved without validation, no accepted shape to name.
  extensions?: Record<string, Record<string, unknown>>;
}

export interface PluginDiagnostic {
  level: 'error' | 'warning' | 'info';

  component: 'manifest' | 'skills' | 'mcp';
  message: string;
}

export interface PluginSkill {
  name: string;

  path: string;

  skillFilePath: string;

  description: string;
}

export interface PluginRemoteMcpConfig {
  type: 'streamable-http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface PluginMcpServer {
  name: string;
  status: 'supported' | 'unsupported-transport' | 'invalid';

  config?: PluginRemoteMcpConfig;

  reason?: string;
}

export interface PluginMcpComponent {
  status: 'absent' | 'invalid' | 'loaded';
  servers: PluginMcpServer[];
}

export interface LoadedPlugin {
  root: string;
  manifest: PluginManifest;
  skills: PluginSkill[];
  mcp: PluginMcpComponent;
}

export type PluginLoadResult =
  | { ok: true; plugin: LoadedPlugin; diagnostics: PluginDiagnostic[] }
  | { ok: false; diagnostics: PluginDiagnostic[] };

export interface InstalledPluginEntry {
  root: string;
  version?: string;
  description?: string;
  installedAt?: string;

  mcpServerNames?: string[];

  source?: string;
}

export interface PluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry>;
}
