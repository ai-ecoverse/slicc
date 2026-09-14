export interface HomeDirFS {
  readDir(path: string): Promise<Array<{ name: string; type: string }>>;
  stat(path: string): Promise<{ mtime?: number }>;
}

export const DEFAULT_HOME_DIR = '/home/user';

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
      } catch {}
    }
    const chosen = bestProfiled?.name ?? firstDir;
    return chosen ? `/home/${chosen}` : DEFAULT_HOME_DIR;
  } catch {
    return DEFAULT_HOME_DIR;
  }
}

export function userFromHome(home: string): string {
  const base = home.replace(/\/+$/, '').split('/').pop();
  return base || 'user';
}
