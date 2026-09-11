/**
 * Memory-curation seam — the orchestrator-facing half of the `memory` shell
 * command. `shell/` sits below `scoops/`, so the command cannot import
 * `runAgenticMemoryPass` directly; the kernel host publishes this seam on
 * `globalThis.__slicc_memory` (mirroring `__slicc_agent` / `__slicc_gelatiere`)
 * and the command mirrors the type structurally.
 *
 * `curate` runs exactly the pass the session freezer runs after a chat ends:
 * snapshot → curator scoop → three-way merge onto the cone's memory file,
 * with the bridge writing the per-archive success receipt and status ledger.
 * It does NOT touch the sessions-index bookkeeping (`memoryPending`,
 * `memoryCuratedAt`) — that stays with the freezer and the boot catch-up,
 * which already trusts the bridge's receipt over a stale pending marker
 * (#1989), so a manual pass on a pending archive resolves rather than
 * double-runs.
 */

import type { VirtualFS } from '../fs/index.js';
import { readSessionsIndex } from '../transcript/frozen-archive-format.js';
import type { AgentBridge } from './agent-bridge.js';
import {
  type AgenticMemoryPassResult,
  type CuratorConeRef,
  runAgenticMemoryPass,
} from './agentic-memory.js';
import { runMemoryDreamPass } from './memory-dreaming.js';

export const MEMORY_SEAM_GLOBAL_KEY = '__slicc_memory';

export interface MemoryCurateRequest {
  /** Absolute archive path, e.g. `/sessions/2026-09-11T...-fix-build.md`. */
  sessionArchivePath: string;
  /** Session count the budget derives from (usually the index length). */
  sessionCount: number;
  /** Cone whose memory file the pass rewrites; omitted means the primary. */
  cone?: CuratorConeRef;
}

export interface MemoryDreamRequest {
  /** Cone whose memory file the pass refactors; omitted means the primary. */
  cone?: CuratorConeRef;
  /** UTC date override for deterministic tests; defaults to today's date. */
  today?: string;
}

/** Published on `globalThis.__slicc_memory` by the kernel host. */
export interface MemorySeam {
  curate(request: MemoryCurateRequest): Promise<AgenticMemoryPassResult>;
  /** The nightly refactoring pass (`scoops/memory-dreaming.ts`), on demand. */
  dream(request: MemoryDreamRequest): Promise<AgenticMemoryPassResult>;
}

interface MemorySeamGlobals {
  __slicc_memory?: MemorySeam;
  __slicc_agent?: AgentBridge;
}

/**
 * Build the seam over the worker's shared FS. The agent bridge is resolved
 * at call time — it is published in an earlier boot step, but resolving
 * lazily keeps this seam publishable in any order and fails soft when a
 * float never publishes a bridge at all.
 */
export function createMemorySeam(sharedFs: VirtualFS): MemorySeam {
  return {
    async curate(request: MemoryCurateRequest): Promise<AgenticMemoryPassResult> {
      const bridge = (globalThis as unknown as MemorySeamGlobals).__slicc_agent;
      if (!bridge) {
        return { ok: false, reason: 'agent bridge not published yet', legacyFallbackSafe: false };
      }
      return runAgenticMemoryPass({
        spawn: (options) => bridge.spawn(options),
        vfs: sharedFs,
        sessionArchivePath: request.sessionArchivePath,
        sessionCount: request.sessionCount,
        ...(request.cone ? { cone: request.cone } : {}),
      });
    },
    async dream(request: MemoryDreamRequest): Promise<AgenticMemoryPassResult> {
      const bridge = (globalThis as unknown as MemorySeamGlobals).__slicc_agent;
      if (!bridge) {
        return { ok: false, reason: 'agent bridge not published yet', legacyFallbackSafe: false };
      }
      const sessionCount = (await readSessionsIndex(sharedFs)).length;
      return runMemoryDreamPass({
        spawn: (options) => bridge.spawn(options),
        vfs: sharedFs,
        sessionCount,
        ...(request.cone ? { cone: request.cone } : {}),
        ...(request.today ? { today: request.today } : {}),
      });
    },
  };
}

export function publishMemorySeam(seam: MemorySeam): void {
  (globalThis as unknown as MemorySeamGlobals)[MEMORY_SEAM_GLOBAL_KEY] = seam;
}
