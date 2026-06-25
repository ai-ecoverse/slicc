/**
 * "Always" generalization: propose a minimal glob pattern for a sudo grant.
 *
 * Before a native "Always" dialog is shown, the trusted realm calls
 * `quickLabel` (`providers/quick-llm.ts`) to suggest a generalized glob of
 * the matched command or VFS path. The suggestion pre-fills the editable
 * input; the human confirms/edits it before it becomes a `NOPASSWD` rule.
 *
 * `quickLabel` fails soft to `null` (no API key, network error, empty
 * response). When that happens — or when the model returns something that
 * does not look like a usable pattern — we fall back to the exact value, so
 * "Always" never silently produces a broader grant than the user can see.
 */

import { createLogger } from '../core/logger.js';
import { quickLabel } from '../providers/quick-llm.js';
import type { SudoRequest } from './types.js';

const log = createLogger('sudo-suggest');

const COMMAND_SYSTEM = [
  'You generalize a single shell command into a minimal glob pattern for an',
  'allow-list rule. Output ONLY the pattern on one line — no prose, no quotes,',
  'no backticks. Keep the leading command/sub-command verbatim and replace only',
  'the volatile tail (args, paths, refs) with a single trailing "*".',
  'Examples:',
  '  git push origin main   -> git push*',
  '  rm -rf build/cache      -> rm -rf*',
  '  npm install left-pad    -> npm install*',
].join('\n');

const PATH_SYSTEM = [
  'You generalize a single filesystem path into a minimal glob pattern for an',
  'allow-list rule. Output ONLY the pattern on one line — no prose, no quotes,',
  'no backticks. Keep the meaningful directory prefix and replace the volatile',
  'leaf (and below) with "**". Examples:',
  '  /workspace/.git/config        -> /workspace/.git/**',
  '  /shared/secrets/openai.key    -> /shared/secrets/**',
  '  /workspace/src/app/main.ts    -> /workspace/src/**',
].join('\n');

/**
 * Resolve the editable default pattern for an "Always" grant.
 *
 * Resolution order:
 *  1. An explicit `req.suggestedPattern` (caller already has a rule glob).
 *  2. A `quickLabel`-proposed generalization.
 *  3. The exact `req.detail` (fail soft).
 *
 * Always resolves to a non-empty string; never throws.
 */
export async function suggestPattern(req: SudoRequest, signal?: AbortSignal): Promise<string> {
  if (req.suggestedPattern && req.suggestedPattern.trim().length > 0) {
    return req.suggestedPattern.trim();
  }

  const exact = req.detail.trim();
  const system = req.kind === 'command' ? COMMAND_SYSTEM : PATH_SYSTEM;

  let proposed: string | null = null;
  try {
    proposed = await quickLabel({
      prompt: exact,
      system,
      maxTokens: 40,
      temperature: 0,
      signal,
    });
  } catch (err) {
    // quickLabel already swallows its own errors, but never trust the seam.
    log.debug('suggestPattern: quickLabel threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    proposed = null;
  }

  const cleaned = sanitize(proposed);
  if (cleaned) return cleaned;

  return exact;
}

/**
 * Reduce a model response to a single usable pattern line, or `null` when it
 * does not look like one. Guards against multi-line output, code fences, and
 * empty strings so a noisy completion can never widen a grant.
 */
function sanitize(raw: string | null): string | null {
  if (!raw) return null;
  const firstLine = raw.split('\n', 1)[0]?.trim() ?? '';
  const stripped = firstLine
    .replace(/^`+/, '')
    .replace(/`+$/, '')
    .replace(/^["']/, '')
    .replace(/["']$/, '')
    .trim();
  if (stripped.length === 0) return null;
  return stripped;
}
