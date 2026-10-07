export type CliFlagType = 'boolean' | 'string' | 'string[]';

export interface CliPositional {
  name: string;
  required: boolean;
  description: string;
}

export interface CliFlag {
  name: string;
  type: CliFlagType;
  description: string;
}

export interface CliCommand {
  path: string[];
  description: string;
  positionals: CliPositional[];
  flags: CliFlag[];
}

export interface HelpCatalog {
  program?: string;
  commands: CliCommand[];

  globalFlags: CliFlag[];
}

export interface JsonSchemaProperty {
  type: 'string' | 'boolean' | 'array' | 'number';
  description?: string;
  items?: { type: 'string' };
}

export interface JsonObjectSchema {
  type: 'object';
  properties: { [key: string]: JsonSchemaProperty };
  required?: string[];
  additionalProperties: false;
}

export type ServeToolKind = 'help' | 'invoke' | 'command';

export interface ServeTool {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  cli: string;
  kind: ServeToolKind;

  commandPath: string[];
}

export interface ServeTarget {
  path: string;
  name?: string;
}

export interface ParsedServeArgs {
  help: boolean;
  list: boolean;

  stop: string | true | null;
  targets: ServeTarget[];
  error?: string;
}

export type ArgValue = string | boolean | number | string[];

export interface ToolArguments {
  stdin?: string;
  passthrough?: string[];
  argv?: string[];
  fields: { name: string; value: ArgValue }[];
  error?: string;
}

const NAME_RE = /^[A-Za-z][\w-]*$/;

export function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'cli';
}

export function cliPrefix(help: string, filePath: string, explicit?: string): string {
  if (explicit) return sanitizeName(explicit);
  const fromUsage = usageProgramName(help);
  if (fromUsage) return sanitizeName(fromUsage);
  const base = filePath.split('/').pop() ?? filePath;
  return sanitizeName(base.replace(/\.jsh$/i, ''));
}

export function parseServeArgs(args: string[]): ParsedServeArgs {
  const targets: ServeTarget[] = [];
  let help = false;
  let list = false;
  let stop: string | true | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--list') {
      list = true;
      continue;
    }
    if (arg === '--stop') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        stop = next;
        i++;
      } else {
        stop = true;
      }
      continue;
    }
    if (arg === '--serve') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        targets.push(splitTarget(next));
        i++;
      }
      continue;
    }
    return { help, list, stop, targets, error: `mcp --serve: unexpected argument ${arg}` };
  }
  return { help, list, stop, targets };
}

export function parseHelp(help: string): HelpCatalog {
  const block = commandsFromBlock(help);
  const program = usageProgramName(help);
  const commands = mergeCommandLists(block.commands, usageCommands(help, program));
  return {
    ...(program ? { program } : {}),
    commands: applyScopedFlags(commands, block.scoped),
    globalFlags: block.globalFlags,
  };
}

export function isGroupCandidate(command: CliCommand): boolean {
  return (
    command.path.length === 1 && command.positionals.length === 0 && command.flags.length === 0
  );
}

export function nestGroup(
  commands: CliCommand[],
  group: string,
  nested: HelpCatalog,
  topNames: ReadonlySet<string>
): CliCommand[] | null {
  const children = attachGlobalFlags(nested.commands, nested.globalFlags);
  if (children.length === 0) return null;
  const childNames = children.map((child) => child.path[0] ?? '');
  const same =
    childNames.length === topNames.size && childNames.every((name) => topNames.has(name));
  if (same) return null;
  const nestedCommands = children.map((child) => ({ ...child, path: childPath(group, child) }));
  return commands.filter((command) => command.path[0] !== group).concat(nestedCommands);
}

export function attachGlobalFlags(commands: CliCommand[], globalFlags: CliFlag[]): CliCommand[] {
  if (globalFlags.length === 0) return commands;
  return commands.map((command) => ({ ...command, flags: mergeFlags(command.flags, globalFlags) }));
}

export function parseMcpOverride(stdout: string): HelpCatalog | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const commandsValue = Object.getOwnPropertyDescriptor(value, 'commands')?.value;
  if (!Array.isArray(commandsValue)) return null;
  const commands: CliCommand[] = [];
  for (const entry of commandsValue) {
    const command = readMcpCommand(entry);
    if (command) commands.push(command);
  }
  if (commands.length === 0) return null;
  return { commands, globalFlags: [] };
}

export function buildTools(prefix: string, commands: CliCommand[]): ServeTool[] {
  const tools: ServeTool[] = [
    {
      name: `${prefix}_help`,
      description: `Show ${prefix} help.`,
      inputSchema: objectSchema({}),
      cli: prefix,
      kind: 'help',
      commandPath: [],
    },
    {
      name: `${prefix}_invoke`,
      description: `Run ${prefix} with an argv array (one element per argument) and optional stdin. A non-zero exit is a tool error.`,
      inputSchema: invokeSchema(),
      cli: prefix,
      kind: 'invoke',
      commandPath: [],
    },
  ];
  for (const command of commands) {
    const leaf = command.path.join('_');
    tools.push({
      name: `${prefix}_${leaf}`,
      description: command.description || `Run ${prefix} ${command.path.join(' ')}`,
      inputSchema: commandSchema(command),
      cli: prefix,
      kind: 'command',
      commandPath: command.path,
    });
  }
  return tools;
}

export function readToolArguments(input: unknown): ToolArguments {
  if (input === undefined || input === null) return { fields: [] };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { fields: [], error: 'arguments must be an object' };
  }
  const fields: { name: string; value: ArgValue }[] = [];
  let stdin: string | undefined;
  let passthrough: string[] | undefined;
  let argv: string[] | undefined;
  for (const key of Object.keys(input)) {
    const value = Object.getOwnPropertyDescriptor(input, key)?.value;
    const read = readArgument(key, value);
    if (read.error) return { fields, error: read.error };
    if (read.stdin !== undefined) stdin = read.stdin;
    else if (read.passthrough) passthrough = read.passthrough;
    else if (read.argv) argv = read.argv;
    else if (read.field) fields.push(read.field);
  }
  return {
    fields,
    ...(stdin !== undefined ? { stdin } : {}),
    ...(passthrough ? { passthrough } : {}),
    ...(argv ? { argv } : {}),
  };
}

export function argvForCommand(
  command: CliCommand,
  args: ToolArguments
): { argv: string[]; stdin?: string } | { error: string } {
  if (args.error) return { error: args.error };
  const argv = [...command.path];
  for (const positional of command.positionals) {
    const found = args.fields.find((field) => field.name === positional.name);
    if (!found) {
      if (positional.required) return { error: `missing ${positional.name}` };
      continue;
    }
    if (typeof found.value !== 'string' && typeof found.value !== 'number') {
      return { error: `${positional.name} must be a string` };
    }
    argv.push(String(found.value));
  }
  const flags = appendFlags(command.flags, args.fields);
  if ('error' in flags) return flags;
  argv.push(...flags.argv);
  if (args.passthrough) argv.push(...args.passthrough);
  return { argv, ...(args.stdin !== undefined ? { stdin: args.stdin } : {}) };
}

function appendFlags(
  flags: CliFlag[],
  fields: { name: string; value: ArgValue }[]
): { argv: string[] } | { error: string } {
  const argv: string[] = [];
  for (const flag of flags) {
    const found = fields.find((field) => field.name === flag.name);
    if (!found || found.value === false) continue;
    const encoded = encodeFlag(flag, found.value);
    if ('error' in encoded) return encoded;
    argv.push(...encoded.argv);
  }
  return { argv };
}

function encodeFlag(flag: CliFlag, value: ArgValue): { argv: string[] } | { error: string } {
  if (flag.type === 'boolean') {
    return value === true ? { argv: [`--${flag.name}`] } : { argv: [] };
  }
  if (flag.type === 'string[]') {
    if (!Array.isArray(value)) return { error: `${flag.name} must be an array of strings` };
    const argv: string[] = [];
    for (const item of value) argv.push(`--${flag.name}`, item);
    return { argv };
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { error: `${flag.name} must be a string` };
  }
  return { argv: [`--${flag.name}`, String(value)] };
}

interface BlockParse {
  commands: CliCommand[];
  globalFlags: CliFlag[];
  scoped: { name: string; flags: CliFlag[] }[];
}

function commandsFromBlock(help: string): BlockParse {
  let section: 'none' | 'commands' | 'options' | 'scoped' = 'none';
  const commands: CliCommand[] = [];
  const globalFlags: CliFlag[] = [];
  const scoped: { name: string; flags: CliFlag[] }[] = [];
  for (const rawLine of help.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ');
    const header = classifyHeader(line);
    if (header) {
      section = header.kind === 'other' ? 'none' : header.kind;
      if (header.kind === 'scoped' && header.name) scoped.push({ name: header.name, flags: [] });
      continue;
    }
    pushSectionLine(section, line, commands, globalFlags, scoped);
  }
  return { commands, globalFlags, scoped };
}

function pushSectionLine(
  section: 'none' | 'commands' | 'options' | 'scoped',
  line: string,
  commands: CliCommand[],
  globalFlags: CliFlag[],
  scoped: { name: string; flags: CliFlag[] }[]
): void {
  if (section === 'commands') {
    const command = parseCommandLine(line);
    if (command) commands.push(command);
    return;
  }
  const flag = parseFlagLine(line);
  if (!flag) return;
  if (section === 'options') globalFlags.push(flag);
  if (section === 'scoped') scoped[scoped.length - 1]?.flags.push(flag);
}

function classifyHeader(
  line: string
): { kind: 'commands' | 'options' | 'scoped' | 'other'; name?: string } | null {
  const text = line.trim();
  if (/^commands:?$/i.test(text)) return { kind: 'commands' };
  if (/^options:?$/i.test(text)) return { kind: 'options' };
  const flags = /^([A-Za-z][\w-]*)\s+flags:?$/i.exec(text);
  if (flags?.[1]) return { kind: 'scoped', name: flags[1].toLowerCase() };
  if (/^[A-Z][A-Z0-9 ]+:$/.test(text)) return { kind: 'other' };
  return null;
}

function parseCommandLine(line: string): CliCommand | null {
  if (!/^\s{2,}\S/.test(line)) return null;
  const parts = line.trim().split(/\s{2,}/);
  if (parts.length < 2) return null;
  const tokens = tokenize(parts[0] ?? '');
  const name = tokens[0] ?? '';
  if (!NAME_RE.test(name) || name.startsWith('-')) return null;
  const spec = emptySpec();
  for (const token of tokens.slice(1)) parseUsageToken(token, spec);
  return {
    path: [name],
    description: parts.slice(1).join(' ').trim(),
    positionals: spec.positionals,
    flags: spec.flags,
  };
}

export function usageProgramName(help: string): string | undefined {
  for (const raw of help.split('\n')) {
    if (!/^[\s>*]*usage:/i.test(raw)) continue;
    const tokens = tokenize(raw);
    const name = tokens[0];
    if (name && NAME_RE.test(name)) return name;
  }
  return undefined;
}

function usageCommands(help: string, program: string | undefined): CliCommand[] {
  const commands: CliCommand[] = [];
  for (const raw of help.split('\n')) {
    const command = usageCommand(raw, program);
    if (command) commands.push(command);
  }
  return commands;
}

function isCommandSlot(token: string): boolean {
  const inner = token
    .replace(/^\[|\]$/g, '')
    .replace(/^<|>$/g, '')
    .toLowerCase();
  return inner === 'command' || inner === 'cmd' || inner === 'subcommand' || inner === 'verb';
}

function usageCommand(raw: string, program: string | undefined): CliCommand | null {
  const line = raw.trim();
  const tokens = tokenize(line);
  if (tokens.length < 2) return null;
  const isUsage = /^usage:/i.test(line);
  if (!isUsage && tokens[0] !== program) return null;
  const path: string[] = [];
  let index = 1;
  while (index < tokens.length && path.length < 2 && NAME_RE.test(tokens[index] ?? '')) {
    path.push(tokens[index] ?? '');
    index++;
  }
  if (path.length === 0) return null;

  if (isCommandSlot(tokens[index] ?? '')) return null;
  const spec = emptySpec();
  for (const token of tokens.slice(index)) parseUsageToken(token, spec);
  return { path, description: '', positionals: spec.positionals, flags: spec.flags };
}

interface SpecBuilder {
  positionals: CliPositional[];
  flags: CliFlag[];
}

function emptySpec(): SpecBuilder {
  return { positionals: [], flags: [] };
}

function parseUsageToken(token: string, into: SpecBuilder): void {
  const optional = token.startsWith('[') && token.endsWith(']');
  const inner = optional ? token.slice(1, -1).trim() : token;
  if (inner.startsWith('--')) {
    const flag = parseFlagToken(inner);
    if (flag) into.flags.push(flag);
    return;
  }
  if (inner.startsWith('<') && inner.endsWith('>')) {
    into.positionals.push({
      name: cleanName(inner.slice(1, -1)),
      required: !optional,
      description: '',
    });
    return;
  }
  if (NAME_RE.test(inner)) {
    into.positionals.push({ name: cleanName(inner), required: !optional, description: '' });
  }
}

function parseFlagToken(inner: string): CliFlag | null {
  const match = /^--([A-Za-z][\w-]*)(?:(?:=|\s+)(\S+))?$/.exec(inner.trim());
  if (!match?.[1]) return null;
  const value = match[2] ?? '';
  if (!value) return { name: match[1], type: 'boolean', description: '' };
  return { name: match[1], type: value.includes('...') ? 'string[]' : 'string', description: '' };
}

function parseFlagLine(line: string): CliFlag | null {
  const trimmed = line.trim();
  if (!trimmed.includes('--')) return null;
  const match = /--([A-Za-z][\w-]*)(?:=(\S+)|(?:\s+(<[^>]+>|\[[^\]]+\]|[A-Z][A-Z0-9_-]+)))?/.exec(
    trimmed
  );
  if (!match?.[1]) return null;
  const value = match[2] || match[3] || '';
  const repeatable = /\brepeat|\.\.\.|one or more/i.test(trimmed);
  const description = flagDescription(trimmed);
  if (!value && !repeatable) return { name: match[1], type: 'boolean', description };
  return { name: match[1], type: repeatable ? 'string[]' : 'string', description };
}

function flagDescription(line: string): string {
  const parts = line.trim().split(/\s{2,}/);
  return parts.length > 1 ? parts.slice(1).join(' ').trim() : '';
}

function tokenize(line: string): string[] {
  const source = line.trim().replace(/^usage:\s*/i, '');
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === ' ') {
      index++;
      continue;
    }
    const closer = source[index] === '[' ? ']' : source[index] === '<' ? '>' : '';
    if (closer) {
      const end = source.indexOf(closer, index);
      if (end === -1) {
        tokens.push(source.slice(index));
        break;
      }
      tokens.push(source.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    const next = source.indexOf(' ', index);
    if (next === -1) {
      tokens.push(source.slice(index));
      break;
    }
    tokens.push(source.slice(index, next));
    index = next;
  }
  return tokens;
}

function mergeCommandLists(primary: CliCommand[], extra: CliCommand[]): CliCommand[] {
  const merged = primary.map((command) => ({ ...command }));
  for (const command of extra) {
    const existing = merged.find((item) => samePath(item.path, command.path));
    if (!existing) {
      merged.push(command);
      continue;
    }
    if (existing.positionals.length === 0) existing.positionals = command.positionals;
    if (!existing.description) existing.description = command.description;
    existing.flags = mergeFlags(existing.flags, command.flags);
  }
  return merged;
}

function applyScopedFlags(
  commands: CliCommand[],
  scoped: { name: string; flags: CliFlag[] }[]
): CliCommand[] {
  return commands.map((command) => {
    const extra = scoped.find((scope) => scope.name === (command.path[0] ?? '').toLowerCase());
    if (!extra) return command;
    return { ...command, flags: mergeFlags(command.flags, extra.flags) };
  });
}

function mergeFlags(left: CliFlag[], right: CliFlag[]): CliFlag[] {
  const merged = [...left];
  for (const flag of right) {
    if (!merged.some((existing) => existing.name === flag.name)) merged.push(flag);
  }
  return merged;
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function childPath(group: string, child: CliCommand): string[] {
  if (child.path[0] === group) return child.path.slice(0, 2);
  return [group, child.path[0] ?? ''].filter((part) => part.length > 0).slice(0, 2);
}

function cleanName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, '').replace(/^-+/, '');
  return cleaned || 'arg';
}

function readMcpCommand(value: unknown): CliCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = ownString(value, 'name');
  if (!name) return null;
  const path = name
    .split(/\s+/)
    .filter((part) => NAME_RE.test(part))
    .slice(0, 2);
  if (path.length === 0) return null;
  return {
    path,
    description: ownString(value, 'description') ?? '',
    positionals: readMcpPositionals(Object.getOwnPropertyDescriptor(value, 'positionals')?.value),
    flags: readMcpFlags(Object.getOwnPropertyDescriptor(value, 'flags')?.value),
  };
}

function readMcpPositionals(value: unknown): CliPositional[] {
  if (!Array.isArray(value)) return [];
  const positionals: CliPositional[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = ownString(entry, 'name');
    if (!name) continue;
    const required = Object.getOwnPropertyDescriptor(entry, 'required')?.value;
    positionals.push({ name, required: required !== false, description: '' });
  }
  return positionals;
}

function readMcpFlags(value: unknown): CliFlag[] {
  if (!Array.isArray(value)) return [];
  const flags: CliFlag[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = ownString(entry, 'name');
    const type = ownString(entry, 'type');
    if (!name || (type !== 'boolean' && type !== 'string' && type !== 'string[]')) continue;
    flags.push({ name, type, description: '' });
  }
  return flags;
}

function ownString(value: object, key: string): string | undefined {
  const found = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof found === 'string' && found.length > 0 ? found : undefined;
}

function splitTarget(raw: string): ServeTarget {
  const eq = raw.indexOf('=');
  if (eq > 0 && !raw.slice(0, eq).includes('/')) {
    return { name: raw.slice(0, eq), path: raw.slice(eq + 1) };
  }
  return { path: raw };
}

function objectSchema(
  properties: { [key: string]: JsonSchemaProperty },
  required?: string[]
): JsonObjectSchema {
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required && required.length > 0 ? { required } : {}),
  };
}

function invokeSchema(): JsonObjectSchema {
  return objectSchema(
    {
      argv: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments, one element per argument. Never a shell string.',
      },
      stdin: { type: 'string', description: 'Optional standard input.' },
    },
    ['argv']
  );
}

function commandSchema(command: CliCommand): JsonObjectSchema {
  const properties: { [key: string]: JsonSchemaProperty } = {};
  const required: string[] = [];
  for (const positional of command.positionals) {
    properties[positional.name] = {
      type: 'string',
      description: positional.description || positional.name,
    };
    if (positional.required) required.push(positional.name);
  }
  for (const flag of command.flags) {
    properties[flag.name] = flagProperty(flag);
  }
  properties.stdin = { type: 'string', description: 'Optional standard input.' };
  properties.passthrough = {
    type: 'array',
    items: { type: 'string' },
    description: 'Extra arguments appended as-is.',
  };
  return objectSchema(properties, required);
}

function flagProperty(flag: CliFlag): JsonSchemaProperty {
  if (flag.type === 'boolean')
    return { type: 'boolean', description: flag.description || flag.name };
  if (flag.type === 'string[]') {
    return { type: 'array', items: { type: 'string' }, description: flag.description || flag.name };
  }
  return { type: 'string', description: flag.description || flag.name };
}

interface ReadArgument {
  error?: string;
  stdin?: string;
  passthrough?: string[];
  argv?: string[];
  field?: { name: string; value: ArgValue };
}

function readArgument(key: string, value: unknown): ReadArgument {
  if (key === 'stdin') {
    return typeof value === 'string' ? { stdin: value } : { error: 'stdin must be a string' };
  }
  if (key === 'passthrough') return readStringArray(value, 'passthrough');
  if (key === 'argv') {
    const read = readStringArray(value, 'argv');
    return read.passthrough ? { argv: read.passthrough } : read;
  }
  if (!isArgValue(value)) return { error: `${key} has an unsupported type` };
  return { field: { name: key, value } };
}

function readStringArray(value: unknown, label: string): ReadArgument {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { error: `${label} must be an array of strings` };
  }
  return { passthrough: value };
}

function isArgValue(value: unknown): value is ArgValue {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return true;
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
