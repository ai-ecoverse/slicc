import type { VirtualFS } from '../fs/index.js';
import { readSessionsIndex } from '../transcript/frozen-archive-format.js';
import type { AgentBridge } from './agent-bridge.js';
import {
  type AgenticMemoryPassResult,
  type CuratorConeRef,
  runAgenticMemoryPass,
  seedMemoryInstructions,
} from './agentic-memory.js';
import { runMemoryDreamPass } from './memory-dreaming.js';

export const MEMORY_SEAM_GLOBAL_KEY = '__slicc_memory';

export interface MemoryCurateRequest {
  sessionArchivePath: string;

  sessionCount: number;

  cone?: CuratorConeRef;
}

export interface MemoryDreamRequest {
  cone?: CuratorConeRef;

  today?: string;
}

export interface MemorySeam {
  curate(request: MemoryCurateRequest): Promise<AgenticMemoryPassResult>;

  dream(request: MemoryDreamRequest): Promise<AgenticMemoryPassResult>;
}

interface MemorySeamGlobals {
  __slicc_memory?: MemorySeam;
  __slicc_agent?: AgentBridge;
}

export function createMemorySeam(sharedFs: VirtualFS): MemorySeam {
  void seedMemoryInstructions(sharedFs);
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
