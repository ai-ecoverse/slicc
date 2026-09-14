import type { Api } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import {
  type CompactionConfig,
  type CompactionState,
  type CompactionStateDetail,
  createCompactContext,
} from '../../core/context-compaction.js';
import { isFeatureEnabled } from '../../core/feature-flags.js';
import type { Model } from '../../core/index.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import type { AppendConeMemoryMeta } from '../cone-memory-store.js';
import { getAdobeSessionId } from '../llm-session-id.js';
import type { RegisteredScoop } from '../types.js';

export interface SessionHelpersDeps {
  scoop: RegisteredScoop;
  unit: WorkUnitDescriptor;

  coneJid: string | undefined;

  getModelApiKey: () => string | null;

  getEffortOverride: () => string | undefined;
  appendConeMemory?: (bullets: string, meta: AppendConeMemoryMeta) => Promise<void>;
  onCompactionStateChange?: (state: CompactionState, detail: CompactionStateDetail) => void;

  onBeforeCompaction?: CompactionConfig['onBeforeCompaction'];
}

export interface SessionHelpers {
  streamWithSessionId: typeof streamSimple;
  compactFn: ReturnType<typeof createCompactContext>;
  getCompactionApiKey: () => string | undefined;
}

export async function buildSessionHelpers(
  model: Model<Api>,
  deps: SessionHelpersDeps
): Promise<SessionHelpers> {
  const adobeSessionId = await getAdobeSessionId(deps.scoop, deps.coneJid);
  const streamWithSessionId: typeof streamSimple = (m, ctx, opts) => {
    const effort = deps.getEffortOverride();
    const enhanced = effort ? { ...opts, effort } : opts;
    if (m.provider !== 'adobe') return streamSimple(m, ctx, enhanced);
    return streamSimple(m, ctx, {
      ...enhanced,
      headers: { ...opts?.headers, 'X-Session-Id': adobeSessionId },
    });
  };

  const compactionHeaders =
    model.provider === 'adobe' ? { 'X-Session-Id': adobeSessionId } : undefined;
  const getCompactionApiKey = () => deps.getModelApiKey() ?? undefined;
  const appendConeMemory = deps.appendConeMemory;
  const onMemoryUpdates =
    deps.unit.policy.canWriteSharedMemory && appendConeMemory
      ? (bullets: string) =>
          appendConeMemory(bullets, {
            source: 'compaction',
            model,
            apiKey: deps.getModelApiKey() ?? undefined,
            headers: compactionHeaders,
          })
      : undefined;

  const compactFn = createCompactContext({
    model,
    contextWindow:
      typeof model.contextWindow === 'number' && model.contextWindow > 0
        ? model.contextWindow
        : undefined,
    getApiKey: getCompactionApiKey,
    headers: compactionHeaders,
    onMemoryUpdates,

    shouldExtractMemories: () => !isFeatureEnabled('agentic-memory'),

    onCompactionStateChange: (state, detail) => {
      deps.onCompactionStateChange?.(state, detail);
    },
    onBeforeCompaction: deps.onBeforeCompaction,
  });

  return { streamWithSessionId, compactFn, getCompactionApiKey };
}
