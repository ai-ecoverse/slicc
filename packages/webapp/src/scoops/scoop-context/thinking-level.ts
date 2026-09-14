import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import type { Model } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import { THINKING_LEVELS } from '../types.js';

const log = createLogger('scoop-context');

export function resolveThinkingLevel(
  requested: ThinkingLevel | undefined,
  model: Model<Api>
): ThinkingLevel {
  if (!model.reasoning) return 'off';
  if (requested === undefined) return 'off';
  if (requested === 'xhigh' && !getSupportedThinkingLevels(model).includes('xhigh')) return 'high';
  return requested;
}

export function getLockedEffortLevel(): ThinkingLevel | null {
  try {
    const val = localStorage.getItem('slicc_locked_effort_level');
    if (!val) return null;
    if (THINKING_LEVELS.includes(val as ThinkingLevel)) return val as ThinkingLevel;
    log.warn('Unrecognized locked effort level in localStorage, ignoring:', val);
  } catch {}
  return null;
}
