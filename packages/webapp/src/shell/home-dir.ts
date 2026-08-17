/**
 * Canonical HOME resolution for the shell (#2085).
 *
 * Onboarding persists the user's profile to `/home/<slug>/.welcome.json`
 * (`onboarding-orchestrator.ts`), but the slug is a local variable there —
 * every consumer re-derives it by scanning `/home`. This module is the ONE
 * resolver the shell uses so `$HOME`, `cd ~`, and `~/.profile` agree on a
 * single answer.
 *
 * Selection mirrors `setup-welcome-flow.ts`'s `loadPersistedProfile`: among
 * `/home/<dir>/.welcome.json` candidates the most recently written wins
 * (repeated onboardings leave older slugs behind). A home with no profile is
 * still a valid HOME — profile-less directories are considered, but any
 * profile-bearing directory outranks them.
 */

/** Minimal FS surface — VirtualFS, RestrictedFS, and test fakes all satisfy it. */
export interface HomeDirFS {
  readDir(path: string): Promise<Array<{ name: string; type: string }>>;
  stat(path: string): Promise<{ mtime?: number }>;
}

/**
 * Fallback HOME when onboarding never ran (or `/home` was wiped). Matches
 * just-bash's built-in default and the Node realm's `os.homedir()`.
 */
export const DEFAULT_HOME_DIR = '/home/user';

/**
 * Resolve the effective HOME directory from the `/home` tree. Never throws;
 * any FS failure falls back to {@link DEFAULT_HOME_DIR}. Cost is one
 * `readDir` plus one `stat` per candidate — cheap enough for the
 * per-connection tray shells (#2084) that pay it on every construction.
 */
export async function resolveHomeDir(fs: HomeDirFS): Promise<string> {
  try {
    const entries = await fs.readDir('/home');
    let bestProfiled: { name: string; mtime: number } | null = null;
    let firstDir: string | null = null;
    for (const entry of entries) {
      if (entry.type !== 'directory') continue;
      firstDir ??= entry.name;
      try {
        const stat = await fs.stat(`/home/${entry.name}/.welcome.json`);
        const mtime = stat.mtime ?? 0;
        if (!bestProfiled || mtime > bestProfiled.mtime) {
          bestProfiled = { name: entry.name, mtime };
        }
      } catch {
        // no profile in this dir — stays a low-priority candidate
      }
    }
    const chosen = bestProfiled?.name ?? firstDir;
    return chosen ? `/home/${chosen}` : DEFAULT_HOME_DIR;
  } catch {
    return DEFAULT_HOME_DIR;
  }
}

/** `basename(home)` — the effective `$USER` for a resolved home. */
export function userFromHome(home: string): string {
  const base = home.replace(/\/+$/, '').split('/').pop();
  return base || 'user';
}
