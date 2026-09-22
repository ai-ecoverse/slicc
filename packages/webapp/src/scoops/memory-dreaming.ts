import { createLogger } from '../base/logger.js';
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
import {
  curateLiveSessionDelta,
  type LiveCurationVfs,
  liveDeltaCurationEnabled,
} from './live-session-curation.js';

export { dreamerAgentName };

const log = createLogger('memory-dreaming');

export const DREAMER_INSTRUCTIONS: MemoryPassInstructions = {
  kind: 'dream',
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

export async function runMemoryDreamPass(
  opts: RunMemoryDreamPassOptions
): Promise<AgenticMemoryPassResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const folder = opts.cone?.folder ?? PRIMARY_CONE_FOLDER;
  await curateLiveDeltaBeforeDream(opts, folder);
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

async function curateLiveDeltaBeforeDream(
  opts: RunMemoryDreamPassOptions,
  folder: string
): Promise<void> {
  if (!liveDeltaCurationEnabled()) return;
  try {
    await curateLiveSessionDelta({
      vfs: opts.vfs as LiveCurationVfs,
      cone: opts.cone ?? { folder },
      spawn: opts.spawn,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (error) {
    log.warn('Live transcript curation before dream failed', {
      cone: folder,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
