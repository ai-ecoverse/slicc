import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import {
  getAccounts,
  getOAuthAccountInfo,
  getProviderConfig,
} from '../../providers/account-store.js';
import { getFollowerTrayRuntimeStatus } from '../../scoops/tray-follower-status.js';
import { getLeaderTrayRuntimeStatus } from '../../scoops/tray-leader.js';
import {
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrlValue,
  TRAY_WORKER_STORAGE_KEY,
} from '../../scoops/tray-runtime-config.js';
import { getConnectedFollowers } from '../../shell/supplemental-commands/host-command.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { MonitorDeps, MonitorProcessSnapshot, MonitorTrayInfo } from './wc-monitor.js';

const PROC_STATE_LETTER_TO_WORD: Record<string, string> = {
  R: 'running',
  S: 'pending',
  Z: 'exited',
  K: 'killed',
};

/** Parse proc-mount's compact `/proc/<pid>/stat` lifecycle field. */
export function parseProcStatLine(statLine: string): string {
  const stateLetter = statLine.trim().split(' ')[2] ?? '';
  return PROC_STATE_LETTER_TO_WORD[stateLetter] ?? 'unknown';
}

/**
 * Parse the `/proc/table` JSON document into the monitor's snapshot shape,
 * keeping only live rows. The mount retains a window of terminated
 * processes so post-mortem `ps` works; the monitor doesn't render them, and
 * reports `stats.terminated` — the kernel's session total, which keeps
 * counting past that window — instead.
 *
 * Anything malformed degrades to an empty snapshot rather than throwing:
 * a monitor tick is not worth failing a render over.
 */
export function parseProcTable(raw: string): MonitorProcessSnapshot {
  try {
    const doc = JSON.parse(raw) as {
      stats?: { terminated?: number };
      processes?: { pid?: number; argv?: string; status?: string }[];
    };
    const processes = (doc.processes ?? [])
      .filter((row) => row.status === 'running' || row.status === 'pending')
      .map((row) => ({
        pid: Number(row.pid ?? 0),
        argv: String(row.argv ?? ''),
        status: String(row.status ?? 'unknown'),
      }));
    return { processes, terminated: Number(doc.stats?.terminated ?? 0) };
  } catch {
    return { processes: [], terminated: 0 };
  }
}

export function getTrayMonitorInfo(storage: Pick<Storage, 'getItem'>): MonitorTrayInfo {
  const follower = getFollowerTrayRuntimeStatus();
  if (follower.state !== 'inactive') {
    return {
      role: 'follower',
      state: follower.state,
      joinUrl: follower.joinUrl,
      sessionId: follower.trayId,
      workerBaseUrl: parseTrayJoinUrlValue(follower.joinUrl)?.workerBaseUrl ?? null,
      stalled: follower.stalled,
    };
  }

  const leader = getLeaderTrayRuntimeStatus();
  if (leader.state !== 'inactive') {
    return {
      role: 'leader',
      state: leader.state,
      joinUrl: leader.session?.joinUrl,
      sessionId: leader.session?.trayId,
      workerBaseUrl: leader.session?.workerBaseUrl,
    };
  }

  let workerBaseUrl: string | null = null;
  try {
    workerBaseUrl = normalizeTrayWorkerBaseUrl(storage.getItem(TRAY_WORKER_STORAGE_KEY));
  } catch {
    // Storage can be unavailable in a sandboxed page.
  }
  return { role: 'standalone', state: 'inactive', workerBaseUrl };
}

/** Build the monitor's live data adapters without burdening attach orchestration. */
export function createWcMonitorDeps(deps: {
  client: OffscreenClient;
  openReader(): Promise<LocalVfsClient>;
  storage: Pick<Storage, 'getItem'>;
}): MonitorDeps {
  const { client, openReader, storage } = deps;
  return {
    getScoops: () => client.getScoops(),
    isProcessing: (jid) => client.isProcessing(jid),
    getCronTasks: async () => {
      const { getAllCronTasks } = await import('../../scoops/db.js');
      return getAllCronTasks();
    },
    getWebhooks: async () => {
      const { getAllWebhooks } = await import('../../scoops/db.js');
      return getAllWebhooks();
    },
    getMounts: async () => {
      const { getAllMountEntries, loadMountHandle } = await import('../../fs/mount-table-store.js');
      const entries = await getAllMountEntries();
      return Promise.all(
        entries.map(async (entry) => {
          if (entry.descriptor.kind !== 'local') return entry;
          try {
            const rawHandle = await loadMountHandle(entry.descriptor.idbHandleKey);
            const handle = rawHandle as {
              queryPermission?: (desc: { mode: string }) => Promise<string>;
            } | null;
            const permission = await handle?.queryPermission?.({ mode: 'readwrite' });
            return { ...entry, valid: permission === 'granted' };
          } catch {
            return { ...entry, valid: false };
          }
        })
      );
    },
    getMcpServers: async () => {
      try {
        const fs = await openReader();
        const raw = await fs.readFile('/workspace/.mcp/servers.json', { encoding: 'utf-8' });
        const parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        return parsed.servers ?? {};
      } catch {
        return {};
      }
    },
    getOAuthProviders: () => {
      try {
        const seen = new Set<string>();
        const entries: { providerId: string; valid?: boolean }[] = [];
        for (const account of getAccounts()) {
          if (seen.has(account.providerId)) continue;
          seen.add(account.providerId);
          if (!getProviderConfig(account.providerId)?.isOAuth) {
            entries.push({ providerId: account.providerId });
            continue;
          }
          const info = getOAuthAccountInfo(account.providerId);
          const valid = account.loggedOut ? false : info ? !info.expired : false;
          entries.push({ providerId: account.providerId, valid });
        }
        return entries;
      } catch {
        return [];
      }
    },
    getSessionStats: async () => client.getSessionStats?.() ?? null,
    getProcesses: async () => {
      // One read of the `/proc/table` aggregate, not a readDir plus two
      // readFiles per pid. The monitor refreshes every 5s, so the per-pid
      // walk cost ~2N VFS reads a tick — several thousand on a table that
      // had grown into the low thousands, against the same VFS the boot
      // path and terminal mount contend for.
      try {
        const fs = await openReader();
        const raw = await fs.readFile('/proc/table', { encoding: 'utf-8' });
        return parseProcTable(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      } catch {
        return { processes: [], terminated: 0 };
      }
    },
    getTrayInfo: () => getTrayMonitorInfo(storage),
    getConnectedFollowers,
  };
}
