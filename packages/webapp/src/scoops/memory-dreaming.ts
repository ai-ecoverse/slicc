import DEFAULT_DREAMING_MD from '../../../vfs-root/shared/DREAMING.md?raw';
import { PRIMARY_CONE_FOLDER } from '../work-unit/record.js';
import {
  type AgenticMemoryPassResult,
  type CuratorConeRef,
  curatorAgentName,
  dreamerAgentName,
  type MemoryPassInstructions,
  type RunAgenticMemoryPassOptions,
  runAgenticMemoryPass,
} from './agentic-memory.js';

export { DEFAULT_DREAMING_MD };

export const DREAMING_INSTRUCTIONS_PATH = '/shared/DREAMING.md';

export { dreamerAgentName };

export const DREAMER_INSTRUCTIONS: MemoryPassInstructions = {
  path: DREAMING_INSTRUCTIONS_PATH,
  fallback: DEFAULT_DREAMING_MD,
  nameFor: dreamerAgentName,

  rivalsFor: (folder) => [curatorAgentName(folder)],
};

export function dreamStateKey(today: string, folder: string): string {
  return `dream-${today}-${folder}.md`;
}

export interface RunMemoryDreamPassOptions {
  spawn: RunAgenticMemoryPassOptions['spawn'];
  vfs: RunAgenticMemoryPassOptions['vfs'];

  sessionCount: number;

  cone?: CuratorConeRef;

  today?: string;
  signal?: AbortSignal;
}

export function runMemoryDreamPass(
  opts: RunMemoryDreamPassOptions
): Promise<AgenticMemoryPassResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const folder = opts.cone?.folder ?? PRIMARY_CONE_FOLDER;
  return runAgenticMemoryPass({
    spawn: opts.spawn,
    vfs: opts.vfs,
    sessionArchivePath: `/sessions/${dreamStateKey(today, folder)}`,
    sessionCount: opts.sessionCount,
    today,
    instructions: DREAMER_INSTRUCTIONS,
    ...(opts.cone ? { cone: opts.cone } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}
