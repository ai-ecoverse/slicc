/**
 * Reasoning-effort resolution.
 *
 * Owns: mapping a *requested* thinking level onto what a given model can
 * actually serve, and the deployment-wide effort lock read from localStorage.
 *
 * Changes when a model family gains or loses a reasoning tier, or when the
 * effort lock's storage contract moves — independent of the agent lifecycle,
 * which only ever asks "what level should I apply now?".
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import type { Model } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import { THINKING_LEVELS } from '../types.js';

const log = createLogger('scoop-context');

/**
 * Resolve a thinking level against an active model. Returns the value the
 * `Agent` should be initialized with — never throws.
 *
 * Rules:
 *   - Non-reasoning model → always `'off'`, regardless of `requested`.
 *   - `requested === undefined` → `'off'` (default; UI/CLI can opt in).
 *   - `requested === 'xhigh'` and the model does not advertise xhigh support
 *     (via `thinkingLevelMap`) → clamped to `'high'`.
 *   - Otherwise the requested value is passed through.
 *
 * Exposed for tests and re-used by `agent-bridge.ts`.
 */
export function resolveThinkingLevel(
  requested: ThinkingLevel | undefined,
  model: Model<Api>
): ThinkingLevel {
  if (!model.reasoning) return 'off';
  if (requested === undefined) return 'off';
  if (requested === 'xhigh' && !getSupportedThinkingLevels(model).includes('xhigh')) return 'high';
  return requested;
}

/**
 * The deployment-wide effort lock (`slicc_locked_effort_level`), when set: it
 * overrides both the record's level and any UI request. Returns `null` in a
 * worker shim or test env without `localStorage`.
 */
export function getLockedEffortLevel(): ThinkingLevel | null {
  try {
    const val = localStorage.getItem('slicc_locked_effort_level');
    if (!val) return null;
    if (THINKING_LEVELS.includes(val as ThinkingLevel)) return val as ThinkingLevel;
    log.warn('Unrecognized locked effort level in localStorage, ignoring:', val);
  } catch {
    // Worker shim or test env may not have localStorage
  }
  return null;
}
