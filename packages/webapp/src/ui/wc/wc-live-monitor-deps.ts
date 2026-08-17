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
import type { MonitorDeps, MonitorTrayInfo } from './wc-monitor.js';

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
      try {
        const fs = await openReader();
        const entries = await fs.readDir('/proc');
        const processes = [];
        for (const entry of entries.filter(
          (candidate) => candidate.type === 'directory' && /^\d+$/.test(candidate.name)
        )) {
          try {
            const stat = await fs.readFile(`/proc/${entry.name}/stat`, { encoding: 'utf-8' });
            const cmdline = await fs.readFile(`/proc/${entry.name}/cmdline`, {
              encoding: 'utf-8',
            });
            processes.push({
              pid: Number.parseInt(entry.name, 10),
              argv: String(cmdline).trim(),
              status: parseProcStatLine(String(stat)),
            });
          } catch {
            // Process may have exited between listing and reading.
          }
        }
        return processes;
      } catch {
        return [];
      }
    },
    getTrayInfo: () => getTrayMonitorInfo(storage),
    getConnectedFollowers,
  };
}
