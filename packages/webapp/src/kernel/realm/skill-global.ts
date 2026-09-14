export interface SkillFsBridge {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<true>;
  exists(path: string): Promise<boolean>;
}

export type SkillExecBridge = (
  command: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface SkillGlobalDeps {
  argv: string[];
  fs: SkillFsBridge;
  exec: SkillExecBridge;
}

export type SkillConfig = { [key: string]: unknown };

export interface SkillGlobal {
  readonly dir: string;
  readonly root: string;
  readonly refs: string;
  readonly assets: string;
  config(updates?: SkillConfig): Promise<SkillConfig | null>;
  token(providerId: string): Promise<string>;
}

function dirname(path: string): string {
  if (!path) return '';
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '';
  if (idx === 0) return '/';
  return path.substring(0, idx);
}

function skillRootFromScriptDir(dir: string): string {
  if (!dir) return dir;
  const absolute = dir.startsWith('/');
  const parts = dir.split('/').filter((part) => part.length > 0);
  const scriptsIdx = parts.indexOf('scripts');
  if (scriptsIdx < 0) return dir;
  const rootParts = parts.slice(0, scriptsIdx);
  if (rootParts.length === 0) return absolute ? '/' : '';
  return (absolute ? '/' : '') + rootParts.join('/');
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./:@]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function joinChild(dir: string, name: string): string {
  if (dir === '') return name;
  if (dir === '/') return `/${name}`;
  return `${dir}/${name}`;
}

export function createSkillGlobal(deps: SkillGlobalDeps): SkillGlobal {
  const scriptPath = deps.argv[1] ?? '';
  const dir = dirname(scriptPath);
  const root = skillRootFromScriptDir(dir);
  const refs = joinChild(root, 'references');
  const assets = joinChild(root, 'assets');
  const configPath = joinChild(dir, '.config');

  async function readConfig(): Promise<SkillConfig | null> {
    let exists: boolean;
    try {
      exists = await deps.fs.exists(configPath);
    } catch {
      return null;
    }
    if (!exists) return null;
    let raw: string;
    try {
      raw = await deps.fs.readFile(configPath);
    } catch {
      return null;
    }
    const text = typeof raw === 'string' ? raw : String(raw);
    if (!text.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`skill.config(): failed to parse ${configPath}: ${msg}`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SkillConfig;
    }
    throw new Error(`skill.config(): ${configPath} must contain a JSON object`);
  }

  async function config(updates?: SkillConfig): Promise<SkillConfig | null> {
    const existing = await readConfig();
    if (updates === undefined) return existing;
    if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new TypeError('skill.config(updates): updates must be a plain object');
    }
    const merged: SkillConfig = { ...(existing ?? {}), ...updates };
    await deps.fs.writeFile(configPath, JSON.stringify(merged, null, 2) + '\n');
    return merged;
  }

  async function token(providerId: string): Promise<string> {
    if (typeof providerId !== 'string' || !providerId.trim()) {
      throw new TypeError('skill.token(providerId): providerId must be a non-empty string');
    }
    const cmd = `oauth-token ${shellQuote(providerId)}`;
    const { stdout, stderr, exitCode } = await deps.exec(cmd);
    if (exitCode !== 0) {
      const msg = stderr.trim() || `oauth-token exited with code ${exitCode}`;
      throw new Error(`skill.token('${providerId}'): ${msg}`);
    }
    return stdout.replace(/\r?\n+$/, '');
  }

  return Object.freeze({
    dir,
    root,
    refs,
    assets,
    config,
    token,
  });
}
