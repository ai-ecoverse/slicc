/**
 * `skill-global.ts` — the `skill` realm global. Computed once at boot
 * from `process.argv[1]` and exposed as a frozen object to user code.
 *
 * Replaces the ad-hoc `const _SCRIPT_DIR = process.argv[1].substring(
 * 0, process.argv[1].lastIndexOf('/'))` incantation that concur,
 * llm-wiki, and oryx each ship today, plus the bespoke per-skill
 * `.config` JSON readers and OAuth-token fetchers.
 *
 * Surface:
 *  - `skill.dir`     — directory containing the running script
 *  - `skill.refs`    — `<dir>/references`
 *  - `skill.assets`  — `<dir>/assets`
 *  - `skill.config()`            — parsed JSON at `<dir>/.config`, or `null`
 *  - `skill.config({ key: v })`  — shallow merge + write, returns the merged object
 *  - `skill.token(providerId)`   — shells out to `oauth-token <id>`
 *
 * `skill.token` shells out via the existing `exec` RPC rather than
 * reaching into the provider registry directly — the realm already has
 * `exec`, the `oauth-token` command is the single audited surface for
 * token retrieval, and this keeps the kernel-side wiring trivial.
 */

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

export interface SkillGlobal {
  readonly dir: string;
  readonly refs: string;
  readonly assets: string;
  config(updates?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  token(providerId: string): Promise<string>;
}

function dirname(path: string): string {
  if (!path) return '';
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '';
  if (idx === 0) return '/';
  return path.substring(0, idx);
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./:@]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Join a directory and a child name without producing double slashes
 * when `dir` is the filesystem root. `dir === ''` is the bare
 * "no slash in argv" fallback and keeps the relative shape the
 * pre-PR-786 code shipped.
 */
function joinChild(dir: string, name: string): string {
  if (dir === '') return name;
  if (dir === '/') return `/${name}`;
  return `${dir}/${name}`;
}

export function createSkillGlobal(deps: SkillGlobalDeps): SkillGlobal {
  const scriptPath = deps.argv[1] ?? '';
  const dir = dirname(scriptPath);
  const refs = joinChild(dir, 'references');
  const assets = joinChild(dir, 'assets');
  const configPath = joinChild(dir, '.config');

  async function readConfig(): Promise<Record<string, unknown> | null> {
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
      return parsed as Record<string, unknown>;
    }
    throw new Error(`skill.config(): ${configPath} must contain a JSON object`);
  }

  async function config(
    updates?: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    const existing = await readConfig();
    if (updates === undefined) return existing;
    if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new TypeError('skill.config(updates): updates must be a plain object');
    }
    const merged: Record<string, unknown> = { ...(existing ?? {}), ...updates };
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
    refs,
    assets,
    config,
    token,
  });
}
