/**
 * Per-unit LLM plumbing: the Adobe session header and the compaction sink.
 *
 * Owns: the `streamSimple` wrapper that attaches `X-Session-Id` and the raw
 * effort override, and the `createCompactContext` instance (memory sink,
 * headers, feature-gated extraction) the agent's `transformContext` runs.
 *
 * Changes when the provider contract or the compaction policy changes. The
 * `X-Session-Id` invariant lives here on purpose: it is one wrapper, easy to
 * audit, instead of a header spread across an init method.
 */

import type { Api } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { createCompactContext } from '../../core/context-compaction.js';
import { isFeatureEnabled } from '../../core/feature-flags.js';
import type { Model } from '../../core/index.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import type { AppendConeMemoryMeta } from '../cone-memory-store.js';
import { getAdobeSessionId } from '../llm-session-id.js';
import type { RegisteredScoop } from '../types.js';

export interface SessionHelpersDeps {
  scoop: RegisteredScoop;
  unit: WorkUnitDescriptor;
  /** Owning cone's JID, for the Adobe session derivation. */
  coneJid: string | undefined;
  /** Credential for the provider the unit's model actually runs on (#2195). */
  getModelApiKey: () => string | null;
  /** Raw API effort override (e.g. `'max'`) bypassing pi-ai's ThinkingLevel. */
  getEffortOverride: () => string | undefined;
  appendConeMemory?: (bullets: string, meta: AppendConeMemoryMeta) => Promise<void>;
  onCompactionStateChange?: (
    state: 'summarizing' | 'extracting-memory' | 'fallback' | 'idle'
  ) => void;
}

export interface SessionHelpers {
  streamWithSessionId: typeof streamSimple;
  compactFn: ReturnType<typeof createCompactContext>;
  getCompactionApiKey: () => string | undefined;
}

/** Build Adobe session ID and streaming/compaction helpers. */
export async function buildSessionHelpers(
  model: Model<Api>,
  deps: SessionHelpersDeps
): Promise<SessionHelpers> {
  const adobeSessionId = await getAdobeSessionId(deps.scoop, deps.coneJid);
  const streamWithSessionId: typeof streamSimple = (m, ctx, opts) => {
    // Inject the raw effort override (e.g. 'max') when the UI-level
    // effort exceeds pi-ai's ThinkingLevel range. The provider's
    // adaptive-thinking shim reads `effort` before falling back to
    // the `reasoning` ThinkingLevel.
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
    // With agentic memory enabled, the end-of-session curator is the
    // ONLY memory builder (#2003): mid-session extraction appends legacy
    // bullets to the curated file and triggers the legacy budget
    // restructure, repeatedly squeezing curated content until only the
    // recent session survives. Checked live at EACH compaction (the
    // compactFn built here outlives prompts), so an avatar-dialog toggle
    // applies to the next compaction without a reload; the flag resolves
    // in this (worker) realm via the seeded/synced localStorage shim
    // plus the remote cache adopted at boot.
    shouldExtractMemories: () => !isFeatureEnabled('agentic-memory'),
    // States flow to the UI untouched; OffscreenClient renders the
    // transcript notices (#1985). Emitting them here via onResponse would
    // clobber the streaming bubble on the bridge path and poison non-cone
    // scoops' completion buffers routed back to the cone.
    onCompactionStateChange: (state) => {
      deps.onCompactionStateChange?.(state);
    },
  });

  return { streamWithSessionId, compactFn, getCompactionApiKey };
}
