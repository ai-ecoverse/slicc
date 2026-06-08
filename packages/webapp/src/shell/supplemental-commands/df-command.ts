/**
 * `df` — read-only diagnostics for the active VFS.
 *
 * Reports the active backend (`opfs` vs `memory`), the live
 * `navigator.storage.estimate()` usage + quota, the persistence flag
 * from `navigator.storage.persisted()`, and the OPFS migration state
 * (sentinel + legacy `slicc-fs` IDB presence). Worker-float safe.
 *
 * `diskutil info` is registered as a separate alias command that
 * produces the same report so the macOS muscle-memory works.
 *
 * Strictly read-only — no FS mutations and no destructive IDB calls.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import {
  probeLegacyIdbExistsDefault,
  sentinelExistsOnVfs,
} from '../../fs/migration/migration-cleanup.js';

export interface DfCommandOptions {
  /** Shared VFS used for backend + sentinel probing. */
  fs?: VirtualFS;
  /** Override for the OPFS sentinel probe (tests). */
  sentinelExists?: (fs: VirtualFS) => Promise<boolean>;
  /** Override for the legacy `slicc-fs` IDB probe (tests). */
  legacyIdbExists?: () => Promise<boolean>;
}

interface DfReport {
  backend: 'opfs' | 'memory' | 'unknown';
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
  sentinelPresent: boolean | null;
  legacyIdbPresent: boolean | null;
}

function helpText(name: string): string {
  return `${name} — report VFS backend, storage usage/quota, and migration state

Usage:
  ${name}                 Show diagnostics (raw bytes).
  ${name} -h              Show diagnostics (human-readable sizes).
  ${name} --help          Show this help.

Read-only. Cleanup of the legacy IndexedDB lives in 'slicc-fs-cleanup'.
`;
}

function diskutilHelpText(): string {
  return `diskutil — VFS diagnostics alias

Usage:
  diskutil info           Show VFS diagnostics (alias for 'df -h').
  diskutil --help         Show this help.

Read-only. See 'df --help' for the underlying command.
`;
}

function humanReadable(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const formatted =
    value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted} ${units[unitIndex]}`;
}

function formatBytes(bytes: number | null, human: boolean): string {
  if (bytes === null) return 'unavailable';
  return human ? humanReadable(bytes) : `${bytes}`;
}

async function buildReport(options: DfCommandOptions): Promise<DfReport> {
  const fs = options.fs;
  const backend: DfReport['backend'] = fs?.backend ?? 'unknown';

  let usage: number | null = null;
  let quota: number | null = null;
  let persisted: boolean | null = null;
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  if (storage) {
    try {
      const estimate = await storage.estimate();
      usage = typeof estimate.usage === 'number' ? estimate.usage : null;
      quota = typeof estimate.quota === 'number' ? estimate.quota : null;
    } catch {
      /* estimate unavailable — leave as null */
    }
    if (typeof storage.persisted === 'function') {
      try {
        persisted = await storage.persisted();
      } catch {
        persisted = null;
      }
    }
  }

  let sentinelPresent: boolean | null = null;
  let legacyIdbPresent: boolean | null = null;
  if (fs && fs.backend === 'opfs') {
    const sentinelProbe = options.sentinelExists ?? sentinelExistsOnVfs;
    try {
      sentinelPresent = await sentinelProbe(fs);
    } catch {
      sentinelPresent = null;
    }
  }
  const idbProbe = options.legacyIdbExists ?? probeLegacyIdbExistsDefault;
  try {
    legacyIdbPresent = await idbProbe();
  } catch {
    legacyIdbPresent = null;
  }

  return { backend, usage, quota, persisted, sentinelPresent, legacyIdbPresent };
}

function renderReport(report: DfReport, human: boolean): string {
  const used =
    report.usage !== null && report.quota !== null && report.quota > 0
      ? `${Math.round((report.usage / report.quota) * 100)}%`
      : 'unavailable';
  const persistedLabel =
    report.persisted === null ? 'unavailable' : report.persisted ? 'true' : 'false';
  let migrated: string;
  if (report.backend !== 'opfs') {
    migrated = 'n/a (backend is not opfs)';
  } else if (report.sentinelPresent === null) {
    migrated = 'unavailable';
  } else {
    migrated = report.sentinelPresent
      ? 'yes (/.slicc-migrated present)'
      : 'no (/.slicc-migrated absent)';
  }
  const legacy =
    report.legacyIdbPresent === null
      ? 'unavailable'
      : report.legacyIdbPresent
        ? 'present (slicc-fs)'
        : 'absent';
  const lines = [
    `Backend:     ${report.backend}`,
    `Usage:       ${formatBytes(report.usage, human)}`,
    `Quota:       ${formatBytes(report.quota, human)}`,
    `Used:        ${used}`,
    `Persisted:   ${persistedLabel}`,
    `Migrated:    ${migrated}`,
    `Legacy IDB:  ${legacy}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function createDfCommand(options: DfCommandOptions = {}): Command {
  return defineCommand('df', async (args) => {
    if (args.includes('--help')) {
      return { stdout: helpText('df'), stderr: '', exitCode: 0 };
    }
    const known = new Set(['-h', '--human-readable']);
    const unknown = args.find((a) => !known.has(a));
    if (unknown !== undefined) {
      return { stdout: '', stderr: `df: unsupported argument: ${unknown}\n`, exitCode: 1 };
    }
    const human = args.includes('-h') || args.includes('--human-readable');
    const report = await buildReport(options);
    return { stdout: renderReport(report, human), stderr: '', exitCode: 0 };
  });
}

export function createDiskutilCommand(options: DfCommandOptions = {}): Command {
  return defineCommand('diskutil', async (args) => {
    if (args.includes('--help')) {
      return { stdout: diskutilHelpText(), stderr: '', exitCode: 0 };
    }
    const sub = args[0];
    if (sub !== 'info') {
      return {
        stdout: '',
        stderr: sub
          ? `diskutil: unsupported subcommand: ${sub} (try 'diskutil info')\n`
          : "diskutil: missing subcommand (try 'diskutil info')\n",
        exitCode: 1,
      };
    }
    const report = await buildReport(options);
    return { stdout: renderReport(report, true), stderr: '', exitCode: 0 };
  });
}
