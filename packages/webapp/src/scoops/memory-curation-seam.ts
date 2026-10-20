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
 * The pass's outcome lands on the archive's index row (`memoryCuratedAt`, or
 * a `memoryFailed` note) so `memory status` reflects it (#3849), but the
 * pending markers stay with the freezer and the boot catch-up, which already
 * trusts the bridge's receipt over a stale pending marker (#1989) — a manual
 * pass on a pending archive resolves rather than double-runs.
 */

import type { VirtualFS } from '../fs/index.js';
import { readSessionsIndex } from '../transcript/frozen-archive-format.js';
import { AGENT_NAME_IN_USE_PREFIX, type AgentBridge } from './agent-bridge.js';
import {
  type AgenticMemoryPassResult,
  type CuratorConeRef,
  runAgenticMemoryPass,
  seedMemoryInstructions,
} from './agentic-memory.js';
import { stampCurationOutcome } from './live-session-curation.js';
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
  // The seam is built once at kernel boot, off the eager graph — the right
  // moment to seed `/etc/MEMORY.md` (only when absent) so the user can edit
  // the document both passes run under. Best-effort and detached: a pass
  // falls back to the bundled text when the file is missing.
  void seedMemoryInstructions(sharedFs);
  return {
    async curate(request: MemoryCurateRequest): Promise<AgenticMemoryPassResult> {
      const bridge = (globalThis as unknown as MemorySeamGlobals).__slicc_agent;
      if (!bridge) {
        return { ok: false, reason: 'agent bridge not published yet', legacyFallbackSafe: false };
      }
      const result = await runAgenticMemoryPass({
        spawn: (options) => bridge.spawn(options),
        vfs: sharedFs,
        sessionArchivePath: request.sessionArchivePath,
        sessionCount: request.sessionCount,
        ...(request.cone ? { cone: request.cone } : {}),
      });
      await recordOutcome(sharedFs, request.sessionArchivePath, result);
      return result;
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

/**
 * Ledger write for a pass over an archive that has an index row
 * (`/sessions/<file>`). A name-in-use rejection ran nothing, so it records
 * nothing; the running namesake will record its own outcome.
 */
async function recordOutcome(
  fs: VirtualFS,
  sessionArchivePath: string,
  result: AgenticMemoryPassResult
): Promise<void> {
  const match = /^\/sessions\/([^/]+)$/.exec(sessionArchivePath);
  if (!match) return;
  if (!result.ok && result.reason.startsWith(AGENT_NAME_IN_USE_PREFIX)) return;
  await stampCurationOutcome(
    fs,
    match[1],
    result.ok ? { ok: true } : { ok: false, reason: result.reason }
  );
}

export function publishMemorySeam(seam: MemorySeam): void {
  (globalThis as unknown as MemorySeamGlobals)[MEMORY_SEAM_GLOBAL_KEY] = seam;
}
