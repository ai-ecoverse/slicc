/**
 * Sudoers policy parser + matcher.
 *
 * Pure, framework-free module that loads and evaluates the SLICC sudoers
 * policy (`/etc/sudoers` + `/etc/sudoers.d/*` drop-ins). It parses `Cmnd`,
 * `Read`, and `Write` directives (plus `NOPASSWD`-tagged variants) and
 * answers two questions: does a command segment require approval, and does a
 * read/write to a path require approval. A hardcoded self-protection
 * invariant always gates writes to the sudoers files themselves.
 *
 * No UI, no FS, no shell wiring — those live in their own tasks.
 */

import { createLogger } from '../../core/logger.js';
import { normalizePath } from '../../fs/path-utils.js';

const log = createLogger('sudo:sudoers');

/** Outcome of a match against the policy. */
export type MatchResult = 'require-approval' | 'nopasswd-allow' | 'no-match';

/** Filesystem operation kind for path matching. */
export type PathOp = 'read' | 'write';

/** A single compiled policy rule. */
export interface SudoersRule {
  /** Glob pattern exactly as written in the sudoers file. */
  pattern: string;
  /** Whether the rule carried the `NOPASSWD` tag (an explicit grant). */
  nopasswd: boolean;
  /** Compiled matcher for the pattern. */
  regex: RegExp;
}

/** Parsed + merged policy model. */
export interface SudoersPolicy {
  cmnd: SudoersRule[];
  read: SudoersRule[];
  write: SudoersRule[];
}

/** Path to the primary sudoers file (self-protected for writes). */
export const SUDOERS_FILE = '/etc/sudoers';
/** Directory of sudoers drop-ins (self-protected for writes). */
export const SUDOERS_D_DIR = '/etc/sudoers.d';

/** Matches the canonical per-scoop sudoers path `/scoops/<folder>/etc/sudoers`. */
const SCOOP_SUDOERS_RE = /^\/scoops\/[^/]+\/etc\/sudoers$/;

/** Construct the canonical per-scoop sudoers path for `folder`. */
export function scoopSudoersPath(folder: string): string {
  return `/scoops/${folder}/etc/sudoers`;
}

/**
 * Default disposition for `no-match` in an enforcement context. The cone uses
 * `'allow'` (no implicit gating); scoops use `'require-approval'` so any path
 * or command not explicitly granted by their per-scoop sudoers file is gated.
 */
export type DefaultDisposition = 'allow' | 'require-approval';

/**
 * Interpret a {@link MatchResult} against the calling context's default
 * disposition for `no-match`. Plain matches (`require-approval`) and explicit
 * grants (`nopasswd-allow`) always win; only `no-match` is upgraded to
 * `require-approval` when the context defaults to `'require-approval'`.
 *
 * The matcher itself is intentionally kept pure — the default lives at the
 * call site so the same policy can be evaluated under different contexts.
 */
export function applyDefaultDisposition(
  match: MatchResult,
  defaultDisposition: DefaultDisposition
): MatchResult {
  if (match !== 'no-match') return match;
  return defaultDisposition === 'require-approval' ? 'require-approval' : 'no-match';
}

/** An empty, self-protection-only policy (the fail-safe baseline). */
export function emptyPolicy(): SudoersPolicy {
  return { cmnd: [], read: [], write: [] };
}

/** Escape a single literal character for use inside a RegExp. */
function escapeRegExpChar(ch: string): string {
  return '.+^$()[]|\\{}'.includes(ch) ? `\\${ch}` : ch;
}

/**
 * Glob → RegExp for command segments. Commands are not path-structured, so
 * `*` (and `**`) match any run of characters and `?` matches a single one.
 */
export function commandGlobToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      re += '.*';
      i += pattern[i + 1] === '*' ? 2 : 1;
    } else if (ch === '?') {
      re += '.';
      i += 1;
    } else {
      re += escapeRegExpChar(ch);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Glob → RegExp for normalized VFS paths. `*` matches within a single path
 * segment (no `/`); `**` matches across segments. A trailing `/**` also
 * matches the directory itself (so `/a/b/**` matches `/a/b`).
 */
export function pathGlobToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (re.endsWith('/')) {
        re = `${re.slice(0, -1)}(?:/.*)?`;
      } else {
        re += '.*';
      }
      i += 2;
      if (pattern[i] === '/') i += 1;
    } else if (ch === '*') {
      re += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escapeRegExpChar(ch);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Collapse a grant pattern to a single trimmed line. A backend-supplied pattern
 * with embedded newlines could otherwise inject extra rules when appended to a
 * sudoers drop-in (or compile to an unexpected RegExp), so persistence paths run
 * the pattern through this first.
 */
export function sanitizeGrantPattern(pattern: string): string {
  return pattern.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

const DIRECTIVES = new Set(['Cmnd', 'Read', 'Write']);

/** Recognized directive keyword for a parsed rule. */
type Directive = 'Cmnd' | 'Read' | 'Write';

interface ParsedLine {
  directive: Directive;
  nopasswd: boolean;
  pattern: string;
}

/** Parse a single non-empty, non-comment line into a directive rule. */
function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  let rest = trimmed;
  let nopasswd = false;

  const firstSpace = rest.search(/\s/);
  const firstToken = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  if (firstToken === 'NOPASSWD') {
    nopasswd = true;
    rest = firstSpace === -1 ? '' : rest.slice(firstSpace).trimStart();
  }

  const dirSpace = rest.search(/\s/);
  const directive = dirSpace === -1 ? rest : rest.slice(0, dirSpace);
  if (!DIRECTIVES.has(directive)) return null;

  const pattern = dirSpace === -1 ? '' : rest.slice(dirSpace).trim();
  if (!pattern) return null;

  return { directive: directive as Directive, nopasswd, pattern };
}

/**
 * Parse a sudoers file body into a policy. Comments (`#`) and blank lines are
 * ignored; unrecognized lines are skipped and logged. The self-protection
 * invariant is NOT stored as a rule — it lives in `matchPath`, so a policy
 * with no rules (the fail-safe baseline) still protects the sudoers files.
 *
 * Fail-safe: any unexpected error collapses to a self-protection-only policy.
 */
export function parseSudoers(text: string): SudoersPolicy {
  const policy = emptyPolicy();
  try {
    if (typeof text !== 'string') return policy;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const parsed = parseLine(line);
      if (!parsed) {
        log.warn('Skipping unrecognized sudoers line', { line });
        continue;
      }
      const compile = parsed.directive === 'Cmnd' ? commandGlobToRegExp : pathGlobToRegExp;
      const rule: SudoersRule = {
        pattern: parsed.pattern,
        nopasswd: parsed.nopasswd,
        regex: compile(parsed.pattern),
      };
      if (parsed.directive === 'Cmnd') policy.cmnd.push(rule);
      else if (parsed.directive === 'Read') policy.read.push(rule);
      else policy.write.push(rule);
    }
    return policy;
  } catch (err) {
    log.error('Failed to parse sudoers; falling back to self-protection only', { err });
    return emptyPolicy();
  }
}

/** Merge multiple parsed policies into one (order is irrelevant to results). */
export function mergePolicies(...policies: SudoersPolicy[]): SudoersPolicy {
  const merged = emptyPolicy();
  for (const p of policies) {
    if (!p) continue;
    merged.cmnd.push(...p.cmnd);
    merged.read.push(...p.read);
    merged.write.push(...p.write);
  }
  return merged;
}

/**
 * Resolve a set of matching rules to a single outcome. A matching `NOPASSWD`
 * grant takes precedence (explicit allow); otherwise any plain match means
 * approval is required; no matching rule means the action is not gated.
 */
function resolve(rules: SudoersRule[], subject: string): MatchResult {
  let required = false;
  for (const rule of rules) {
    if (rule.regex.test(subject)) {
      if (rule.nopasswd) return 'nopasswd-allow';
      required = true;
    }
  }
  return required ? 'require-approval' : 'no-match';
}

/** Match a single command segment against the policy's `Cmnd` rules. */
export function matchCommand(policy: SudoersPolicy, segment: string): MatchResult {
  return resolve(policy.cmnd, segment.trim());
}

/** Whether a write to `normalized` hits the hardcoded self-protection invariant. */
function isSelfProtectedWrite(normalized: string): boolean {
  return (
    normalized === SUDOERS_FILE ||
    normalized === SUDOERS_D_DIR ||
    normalized.startsWith(`${SUDOERS_D_DIR}/`) ||
    SCOOP_SUDOERS_RE.test(normalized)
  );
}

/**
 * Match a read/write to `path` against the policy. Writes to `/etc/sudoers`,
 * anything under `/etc/sudoers.d/`, or any per-scoop sudoers file
 * (`/scoops/<folder>/etc/sudoers`) ALWAYS require approval, regardless of
 * configuration — `NOPASSWD` cannot override the invariant, even though a
 * scoop's sudoers sits inside its own writable tree. Reads of those files
 * are allowed (visudo-style) and fall through to normal matching.
 */
export function matchPath(policy: SudoersPolicy, op: PathOp, path: string): MatchResult {
  const normalized = normalizePath(path);
  if (op === 'write' && isSelfProtectedWrite(normalized)) {
    return 'require-approval';
  }
  return resolve(op === 'read' ? policy.read : policy.write, normalized);
}
