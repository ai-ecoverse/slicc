import { joinPath, normalizePath, splitPath } from '../../fs/path-utils.js';

export type BiomeConfiguration = Record<string, unknown>;

interface BiomeConfigFileSystem {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  resolvePath(base: string, path: string): string;
}

export interface ResolvedBiomeConfiguration {
  path: string;
  configuration: BiomeConfiguration;
}

export type BiomeConfigurationResolution =
  | { ok: true; resolved: ResolvedBiomeConfiguration | null }
  | { ok: false; error: string; exitCode: 1 | 2 };

interface JsonStringState {
  inString: boolean;
  escaped: boolean;
}

function updateStringState(state: JsonStringState, char: string): void {
  if (state.escaped) {
    state.escaped = false;
  } else if (char === '\\') {
    state.escaped = true;
  } else if (char === '"') {
    state.inString = false;
  }
}

function maskLineComment(source: string, start: number): { text: string; end: number } {
  let end = start + 2;
  while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end++;
  return { text: ' '.repeat(end - start), end: end - 1 };
}

function maskBlockComment(source: string, start: number): { text: string; end: number } {
  let text = '  ';
  let end = start + 2;
  while (end < source.length && !(source[end] === '*' && source[end + 1] === '/')) {
    text += source[end] === '\n' || source[end] === '\r' ? source[end] : ' ';
    end++;
  }
  if (end < source.length) {
    text += '  ';
    end++;
  }
  return { text, end };
}

function stripJsonComments(source: string): string {
  let output = '';
  const state: JsonStringState = { inString: false, escaped: false };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (state.inString) {
      output += char;
      updateStringState(state, char);
      continue;
    }
    if (char === '"') {
      state.inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      const masked = maskLineComment(source, i);
      output += masked.text;
      i = masked.end;
      continue;
    }
    if (char === '/' && next === '*') {
      const masked = maskBlockComment(source, i);
      output += masked.text;
      i = masked.end;
      continue;
    }
    output += char;
  }
  return output;
}

function stripTrailingCommas(source: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let next = i + 1;
      while (next < source.length && /\s/.test(source[next])) next++;
      if (source[next] === '}' || source[next] === ']') continue;
    }
    output += char;
  }
  return output;
}

export function parseBiomeJsonc(source: string): BiomeConfiguration {
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(withoutBom))) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('configuration must contain a JSON object');
  }
  return parsed as BiomeConfiguration;
}

async function findDiscoveredConfig(
  fs: BiomeConfigFileSystem,
  searchFrom: string
): Promise<string | null> {
  let directory = normalizePath(searchFrom);
  while (true) {
    if (!directory.split('/').includes('node_modules')) {
      for (const name of ['biome.json', 'biome.jsonc']) {
        const candidate = joinPath(directory, name);
        if (await fs.exists(candidate)) return candidate;
      }
    }
    if (directory === '/') return null;
    directory = splitPath(directory).dir;
  }
}

async function readConfiguration(
  fs: BiomeConfigFileSystem,
  path: string,
  exitCode: 1 | 2
): Promise<BiomeConfigurationResolution> {
  let source: string;
  try {
    source = await fs.readFile(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `biome: failed to read configuration ${path}: ${detail}`, exitCode };
  }
  try {
    return { ok: true, resolved: { path, configuration: parseBiomeJsonc(source) } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `biome: failed to parse configuration ${path}: ${detail}`,
      exitCode,
    };
  }
}

export async function resolveBiomeConfiguration(
  fs: BiomeConfigFileSystem,
  cwd: string,
  searchFrom: string,
  explicitPath: string | null
): Promise<BiomeConfigurationResolution> {
  if (explicitPath !== null) {
    const path = normalizePath(fs.resolvePath(cwd, explicitPath));
    if (!(await fs.exists(path))) {
      return { ok: false, error: `biome: configuration file not found: ${path}`, exitCode: 2 };
    }
    return readConfiguration(fs, path, 2);
  }
  const discovered = await findDiscoveredConfig(fs, searchFrom);
  return discovered === null ? { ok: true, resolved: null } : readConfiguration(fs, discovered, 1);
}
