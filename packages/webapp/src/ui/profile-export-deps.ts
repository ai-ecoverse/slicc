import type { ProfileSecretKind } from '@slicc/shared-ts';
import { GLOBAL_FS_DB_NAME } from '../fs/global-db.js';
import {
  DefaultTranscriptExportService,
  type ExportServiceDeps,
} from '../transcript/export-service.js';
import type {
  ProfileAccount,
  ProfileExportDeps,
  ProfileMcpServersFile,
  ProfileUnit,
} from '../transcript/profile-export.js';

export interface PageProfileExportOptions {
  serviceDeps: ExportServiceDeps;
  listUnits(): readonly ProfileUnit[];
  version: string;
}

interface GlobalFsReader {
  readFile(path: string, options?: { encoding?: 'utf-8' | 'binary' }): Promise<unknown>;
}

let globalFs: Promise<GlobalFsReader> | null = null;

function openGlobalFs(): Promise<GlobalFsReader> {
  globalFs ??= import('../fs/index.js').then(({ VirtualFS }) =>
    VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME })
  );
  return globalFs;
}

async function readGlobalText(path: string): Promise<string | null> {
  try {
    const raw = await (await openGlobalFs()).readFile(path, { encoding: 'utf-8' });
    if (typeof raw === 'string') return raw;
    return ArrayBuffer.isView(raw) ? new TextDecoder().decode(raw) : null;
  } catch {
    return null;
  }
}

async function storedSecretKinds(): Promise<ProfileSecretKind[]> {
  try {
    const [{ resolveSecretTopology }, { createDefaultSecretBackend }] = await Promise.all([
      import('../core/secret-topology.js'),
      import('../shell/supplemental-commands/secret-backends.js'),
    ]);
    const topology = resolveSecretTopology();
    const { entries } = await createDefaultSecretBackend(topology).list();
    if (entries.length === 0) return [];
    return [topology === 'node-rest' ? 'secrets-env' : 'chrome-storage'];
  } catch {
    return [];
  }
}

export function createPageProfileExportDeps(opts: PageProfileExportOptions): ProfileExportDeps {
  return {
    vfs: opts.serviceDeps.vfs,
    listUnits: opts.listUnits,
    createTranscriptSource: (knownSecrets) =>
      new DefaultTranscriptExportService({ ...opts.serviceDeps, knownSecrets }),
    knownSecrets: opts.serviceDeps.knownSecrets,
    accounts: (): ProfileAccount[] => {
      try {
        const raw = JSON.parse(localStorage.getItem('slicc_accounts') ?? '[]');
        return Array.isArray(raw)
          ? raw.filter((a): a is ProfileAccount => typeof a?.providerId === 'string')
          : [];
      } catch {
        return [];
      }
    },
    licks: async () => {
      const db = await import('../scoops/db.js');
      const [crontasks, tasks, webhooks] = await Promise.all([
        db.getAllCronTasks(),
        db.getAllTasks(),
        db.getAllWebhooks(),
      ]);
      return { crontasks, tasks, webhooks };
    },
    mcpServers: async () => {
      const text = await readGlobalText('/workspace/.mcp/servers.json');
      if (!text) return null;
      try {
        const parsed = JSON.parse(text) as ProfileMcpServersFile;
        return parsed && typeof parsed.servers === 'object' ? parsed : null;
      } catch {
        return null;
      }
    },
    mounts: async () => {
      try {
        const { getAllMountEntries } = await import('../fs/mount-table-store.js');
        return (await getAllMountEntries()).map((e) => e.targetPath);
      } catch {
        return [];
      }
    },
    storedSecretKinds,
    githubToken: async () => (await readGlobalText('/workspace/.git/github-token'))?.trim() || null,
    gitconfig: () => readGlobalText('/workspace/.gitconfig'),
    bundledFile: async (path) => {
      const { readBundledFile } = await import('../scoops/skills.js');
      return readBundledFile(path);
    },
    version: opts.version,
    origin: location.origin,
  };
}
