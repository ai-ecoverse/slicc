/**
 * Foundational (`base/` layer) home for the reasoning/thinking-level
 * vocabulary. The `ThinkingLevel` type itself comes from
 * `@earendil-works/pi-agent-core`; the runtime enumeration and its type guard
 * live here so lower layers (e.g. `shell/`'s `agent` command) can validate a
 * `--thinking` value without an up-the-stack back-edge into `scoops/`.
 *
 * `scoops/types.ts` re-exports these so its existing importers are unchanged.
 * New code should import from `base/thinking-level.js`.
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export type { ThinkingLevel };

/** Full enumeration accepted by the `agent --thinking` flag and tools. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

/** Type guard: is `value` a valid {@link ThinkingLevel}? */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}
