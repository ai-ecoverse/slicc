/**
 * Leading-comment → sudo reason for a shell run.
 *
 * An approver looking at `rm -rf /workspace/build` sees WHAT is being asked and
 * nothing about WHY. Agents already write the why down — a script that starts
 * `# clear the stale build before rebuilding` is ordinary, idiomatic shell — so
 * SLICC reads it rather than asking for the same information twice through a
 * separate parameter.
 *
 * Only a comment at the very TOP of the script counts, and only up to the first
 * non-comment line. A comment further down annotates the line it precedes, not
 * the run, and hoisting it would attach an unrelated sentence to an approval
 * prompt.
 *
 * The extracted text rides the run's environment under
 * {@link SUDO_REASON_ENV}, the same channel `__SLICC_RUN_PID` uses: a command
 * reads it from its OWN `ctx.env`, so concurrent runs on one shell cannot pick
 * up each other's reason. It is stripped from the env written back onto the
 * shell, so it never outlives its run.
 */

import { normalizeSudoReason } from '../../sudo/reason.js';

/**
 * Env var carrying the current run's sudo reason. Internal — stripped before
 * the shell's persistent env is updated.
 */
export const SUDO_REASON_ENV = '__SLICC_SUDO_REASON';

/** Shebangs are machine directives, not an explanation of intent. */
const SHEBANG = /^#!/;

/**
 * The leading comment block of `command` as a single-line reason, or `''` when
 * the script does not open with one.
 *
 * Consecutive leading `#` lines join into one sentence so a wrapped
 * explanation survives. Blank lines before the first comment are skipped
 * (leading whitespace in a heredoc-built script is common); a blank line AFTER
 * the block ends it, because the next comment belongs to whatever follows.
 */
export function extractLeadingCommentReason(command: string): string {
  const parts: string[] = [];
  for (const raw of command.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) {
      if (parts.length > 0) break;
      continue;
    }
    if (!line.startsWith('#')) break;
    if (SHEBANG.test(line)) continue;
    const text = line.replace(/^#+/, '').trim();
    if (text) parts.push(text);
  }
  return normalizeSudoReason(parts.join(' '));
}
