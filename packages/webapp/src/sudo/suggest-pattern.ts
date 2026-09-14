import { createLogger } from '../base/logger.js';
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
    log.debug('suggestPattern: quickLabel threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    proposed = null;
  }

  const cleaned = sanitize(proposed);
  if (cleaned) return cleaned;

  return exact;
}

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
