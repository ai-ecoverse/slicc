import type { CliCommand, CliFlag } from './serve-catalog.js';

export const MCP_SERVE_PATH = '/workspace/.mcp/served.json';

export interface PublishedCli {
  name: string;
  path: string;
  helpText: string;
  commands: CliCommand[];
}

export interface McpPublication {
  url: string;
  token: string;
  grantGeneration: number;
  clis: PublishedCli[];
}

export interface TextFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

export async function loadPublication(fs: TextFs): Promise<McpPublication | null> {
  if (!(await fs.exists(MCP_SERVE_PATH))) return null;
  let raw = '';
  try {
    raw = await fs.readFile(MCP_SERVE_PATH);
  } catch {
    return null;
  }
  if (!raw.trim() || raw.trim() === 'null') return null;
  try {
    return parsePublication(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function savePublication(
  fs: TextFs,
  publication: McpPublication | null
): Promise<void> {
  await fs.mkdir('/workspace/.mcp');
  await fs.writeFile(MCP_SERVE_PATH, publication ? JSON.stringify(publication) : 'null');
}

function parsePublication(value: unknown): McpPublication | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const url = readString(value, 'url');
  const token = readString(value, 'token');
  const grantGeneration = readNumber(value, 'grantGeneration');
  const clisValue = Object.getOwnPropertyDescriptor(value, 'clis')?.value;
  if (!url || !token || grantGeneration === undefined || !Array.isArray(clisValue)) return null;
  const clis: PublishedCli[] = [];
  for (const entry of clisValue) {
    const cli = parseCli(entry);
    if (!cli) return null;
    clis.push(cli);
  }
  return { url, token, grantGeneration, clis };
}

function parseCli(value: unknown): PublishedCli | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = readString(value, 'name');
  const path = readString(value, 'path');
  const helpText = readString(value, 'helpText') ?? '';
  const commandsValue = Object.getOwnPropertyDescriptor(value, 'commands')?.value;
  if (!name || !path || !Array.isArray(commandsValue)) return null;
  const commands: CliCommand[] = [];
  for (const entry of commandsValue) {
    const command = parseCommand(entry);
    if (!command) return null;
    commands.push(command);
  }
  return { name, path, helpText, commands };
}

function parseCommand(value: unknown): CliCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const path = readStringArray(value, 'path');
  const description = readString(value, 'description') ?? '';
  const positionals = readPositionals(Object.getOwnPropertyDescriptor(value, 'positionals')?.value);
  const flags = readFlags(Object.getOwnPropertyDescriptor(value, 'flags')?.value);
  if (!path || !positionals || !flags) return null;
  return { path, description, positionals, flags };
}

function readPositionals(value: unknown): CliCommand['positionals'] | null {
  if (!Array.isArray(value)) return null;
  const positionals: CliCommand['positionals'] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const name = readString(entry, 'name');
    const required = Object.getOwnPropertyDescriptor(entry, 'required')?.value;
    if (!name || typeof required !== 'boolean') return null;
    positionals.push({ name, required, description: readString(entry, 'description') ?? '' });
  }
  return positionals;
}

function readFlags(value: unknown): CliFlag[] | null {
  if (!Array.isArray(value)) return null;
  const flags: CliFlag[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const name = readString(entry, 'name');
    const type = readString(entry, 'type');
    if (!name || (type !== 'boolean' && type !== 'string' && type !== 'string[]')) return null;
    flags.push({ name, type, description: readString(entry, 'description') ?? '' });
  }
  return flags;
}

function readString(value: object, key: string): string | undefined {
  const found = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof found === 'string' ? found : undefined;
}

function readNumber(value: object, key: string): number | undefined {
  const found = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}

function readStringArray(value: object, key: string): string[] | null {
  const found = Object.getOwnPropertyDescriptor(value, key)?.value;
  if (!Array.isArray(found) || !found.every((item) => typeof item === 'string')) return null;
  return found;
}
