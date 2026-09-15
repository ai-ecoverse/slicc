/**
 * Sudoers policy parser + matcher.
 *
 * Pure, framework-free module that loads and evaluates the SLICC sudoers
 * policy. Policy is read from `/etc/sudoers` + `/etc/sudoers.d/*` drop-ins and
 * from nowhere else — see {@link isUnhonoredSudoersPath}. It parses `Cmnd`,
 * `Read`, `Write`, and `Export` directives (plus `NOPASSWD`-tagged variants)
 * and answers three questions: does a command segment require approval, does
 * a read/write to a path require approval, and is a transcript export
 * pre-granted. A hardcoded self-protection
 * invariant always gates writes to the sudoers files themselves.
 *
 * No UI, no FS, no shell wiring — those live in their own tasks. It sits in
 * `sudo/` (not `shell/`) so the FS gate can reach it without importing up the
 * stack — see the layer-back-edge ratchet in `packages/dev-tools/tools/`.
 */

import { normalizePath, pathGlobToRegExp } from '../fs/path-utils.js';
import { isEphemeralFdPath, isNoOpWriteDevicePath } from '../fs/virtual-device-paths.js';
import { createLogger } from './logger.js';

export { pathGlobToRegExp } from '../fs/path-utils.js';

const log = createLogger('sudo:sudoers');

/**
 * Outcome of a match against the policy.
 *
 * `deny` is a hard refusal that never reaches an approver: it is the answer
 * for paths SLICC refuses to treat as policy at all (see
 * {@link isUnhonoredSudoersPath}). Every other outcome is advisory — an
 * approver can still say yes.
 */
export type MatchResult = 'require-approval' | 'nopasswd-allow' | 'no-match' | 'deny';

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
  /**
   * Transcript-export grants (`Export <glob>`), matched against the export
   * subject (`active` or `frozen:<sessionId>`). Unlike the other directives
   * an export is ALWAYS gated (there is no "no-match means ungated"): a
   * `NOPASSWD Export` rule is the only way to skip the prompt. Plain
   * `Export` rules are accepted for symmetry but change nothing.
   */
  export: SudoersRule[];
}

/** Path to the primary sudoers file (self-protected for writes). */
export const SUDOERS_FILE = '/etc/sudoers';
/** Directory of sudoers drop-ins (self-protected for writes). */
export const SUDOERS_D_DIR = '/etc/sudoers.d';

/**
 * Instructions the approver agent runs under (biscotto guest seats).
 *
 * Self-protected like sudoers: it decides what a GUEST may do, and a cone
 * acting on a guest's message must not be able to rewrite the rules that gate
 * that same guest without the owner seeing a prompt.
 */
export const APPROVALS_FILE = '/etc/APPROVALS.md';

/**
 * Sudoers-shaped paths inside a scoop sandbox: `/scoops/<folder>/etc/sudoers`
 * and the `sudoers.d` directory that would sit beside it.
 *
 * SLICC honours policy from `/etc/sudoers` and `/etc/sudoers.d/*` and nowhere
 * else. A policy file living inside the sandbox it governs is the VFS
 * equivalent of a world-writable `/etc/sudoers`, which sudo(8) refuses to read
 * for exactly this reason: the subject of the policy must not be able to author
 * it. Per-scoop grants live in `/etc/sudoers.d/scoop-<folder>` instead — same
 * scoping, a location the scoop cannot reach.
 *
 * Only the sandbox-root shape is matched, not any `**\/etc/sudoers` at depth:
 * a checkout of this repository inside a scoop legitimately carries
 * `packages/vfs-root/etc/sudoers` as ordinary file content, and refusing to
 * write it would break `git clone`.
 */
const SCOOP_SUDOERS_RE = /^\/scoops\/[^/]+\/etc\/sudoers(?:\.d(?:\/.*)?)?$/;

/**
 * Whether `path` is a sudoers file SLICC deliberately does not honour — today,
 * the per-scoop shapes matched by {@link SCOOP_SUDOERS_RE}. Writes to these
 * paths are refused outright (`matchPath` → `'deny'`) rather than raised as an
 * approval: a prompt would offer an approver the chance to hand a scoop a
 * policy file that, once honoured, could grant that scoop anything. Reads are
 * untouched — the file is inert content, not policy.
 */
export function isUnhonoredSudoersPath(path: string): boolean {
  return SCOOP_SUDOERS_RE.test(normalizePath(path));
}

/**
 * Protected layout directory (self-protected for writes).
 *
 * Layout documents that must not change without the user's say-so live here —
 * an embedder-pushed arrangement, or a layout the user wants pinned. Agent
 * writes require approval exactly like `/etc/sudoers`, and no `NOPASSWD` rule
 * can grant them.
 *
 * Freely agent-writable layouts live at `/workspace/layouts/` instead, which is
 * the normal path: SLICC does not prompt for ordinary agent work, so saving and
 * loading layouts is ungated by default. This directory is the opt-in exception
 * for the arrangements where that isn't wanted.
 */
export const PROTECTED_LAYOUTS_DIR = '/etc/slicc/layouts';

/** Filename prefix for the per-scoop drop-ins under `/etc/sudoers.d/`. */
export const SCOOP_GRANTS_PREFIX = 'scoop-';

/**
 * Whether `folder` can be embedded in a drop-in filename without escaping
 * `/etc/sudoers.d/`. Scoop folders are generated (`agent-<adjective>-<flavor>`,
 * a slugged scoop name), so this only ever rejects a caller passing something
 * it made up.
 */
export function isSafeScoopFolder(folder: string): boolean {
  return folder.length > 0 && folder !== '.' && folder !== '..' && !/[/\\]/.test(folder);
}

/**
 * Drop-in holding a scoop's approved "Always" grants:
 * `/etc/sudoers.d/scoop-<folder>`.
 *
 * Root-owned in the SLICC sense — inside the self-protected `/etc/sudoers.d/`
 * tree, outside every scoop sandbox, so the scoop the grants apply to can
 * neither write it nor (absent an explicit `Read` rule) see it. `SudoManager`
 * keeps these drop-ins OUT of the global policy merge and loads each one only
 * for its own scoop, so a grant stays as narrowly scoped as it was when the
 * per-scoop file lived in the sandbox.
 *
 * Returns `null` for a folder that cannot be spelled as a filename.
 */
export function scoopGrantsPath(folder: string): string | null {
  return isSafeScoopFolder(folder) ? `${SUDOERS_D_DIR}/${SCOOP_GRANTS_PREFIX}${folder}` : null;
}

/** Scoop folder owning drop-in `name` (bare filename), or `null` if it is not one. */
export function scoopFolderFromGrantsName(name: string): string | null {
  return name.startsWith(SCOOP_GRANTS_PREFIX)
    ? name.slice(SCOOP_GRANTS_PREFIX.length) || null
    : null;
}

/**
 * The pre-#3106 per-scoop sudoers path. Retained only so `SudoManager` can
 * find a legacy file and discard it fail-closed (no trustworthy provenance
 * to promote into {@link scoopGrantsPath}). Nothing evaluates policy from
 * here any more.
 */
export function legacyScoopSudoersPath(folder: string): string {
  return `/scoops/${folder}/etc/sudoers`;
}

/**
 * Default disposition for `no-match` in an enforcement context. The cone uses
 * `'allow'` (no implicit gating); scoops use `'require-approval'` so any path
 * or command not explicitly granted by their `ScoopConfig` sandbox or their
 * `/etc/sudoers.d/scoop-<folder>` drop-in is gated.
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
  return { cmnd: [], read: [], write: [], export: [] };
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
  // dotAll ('s') so `*` and `?` match across newlines in multiline commands
  return new RegExp(`^${re}$`, 's');
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

const DIRECTIVES = new Set(['Cmnd', 'Read', 'Write', 'Export']);

/** Recognized directive keyword for a parsed rule. */
export type Directive = 'Cmnd' | 'Read' | 'Write' | 'Export';

/**
 * Sudoers directive for a sudo request kind. `secret` gates persist through
 * the command table (`Cmnd`) like the `secret` shell command does today.
 */
export function directiveForKind(
  kind: 'command' | 'read' | 'write' | 'secret' | 'export'
): Directive {
  switch (kind) {
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'export':
      return 'Export';
    default:
      return 'Cmnd';
  }
}

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
      // Export subjects (`active`, `frozen:<id>`) are flat tokens like
      // commands, so they share the command glob (no path-segment semantics).
      const compile =
        parsed.directive === 'Cmnd' || parsed.directive === 'Export'
          ? commandGlobToRegExp
          : pathGlobToRegExp;
      const rule: SudoersRule = {
        pattern: parsed.pattern,
        nopasswd: parsed.nopasswd,
        regex: compile(parsed.pattern),
      };
      if (parsed.directive === 'Cmnd') policy.cmnd.push(rule);
      else if (parsed.directive === 'Read') policy.read.push(rule);
      else if (parsed.directive === 'Export') policy.export.push(rule);
      else policy.write.push(rule);
    }
    return policy;
  } catch (err) {
    log.error('Failed to parse sudoers; falling back to self-protection only', { err });
    return emptyPolicy();
  }
}

/**
 * Grants every scoop sandbox carries on top of its own sudoers file.
 *
 * `/tmp` is global scratch space in SLICC the same way it is on Unix: tooling
 * hardcodes `/tmp/<file>` rather than discovering a scratch dir, so without
 * this every such write escalates to the cone for approval. The space is
 * deliberately SHARED, not per-scoop — scoops can read and clobber each
 * other's scratch files and the cone sees all of them, so nothing secret or
 * trust-bearing belongs here.
 *
 * These live in code rather than in `/etc/sudoers.d/scoop-<folder>` because
 * that file carries only persisted "Always" grants (#2416) — a file-based
 * grant would never reach a scoop that was not explicitly granted it.
 *
 * Self-protection is unaffected: it lives in `matchPath` and no `NOPASSWD`
 * rule — including these — can override it.
 */
const BUILTIN_SCOOP_GRANTS = [
  'NOPASSWD Read /tmp',
  'NOPASSWD Read /tmp/**',
  'NOPASSWD Write /tmp',
  'NOPASSWD Write /tmp/**',
].join('\n');

let builtinScoopPolicy: SudoersPolicy | null = null;

/**
 * The compiled {@link BUILTIN_SCOOP_GRANTS} policy. Parsed once and shared —
 * rules are treated as immutable everywhere (matching only ever calls
 * `regex.test`), so handing the same objects to every merge is safe.
 *
 * The matching ACL exemption is `ALWAYS_WRITABLE_PREFIXES` in
 * `fs/restricted-fs.ts`. SudoFS and RestrictedFS gate independently, so both
 * layers must agree — granting here alone leaves the write walled underneath.
 */
export function builtinScoopGrants(): SudoersPolicy {
  builtinScoopPolicy ??= parseSudoers(BUILTIN_SCOOP_GRANTS);
  return builtinScoopPolicy;
}

/** Merge multiple parsed policies into one (order is irrelevant to results). */
export function mergePolicies(...policies: SudoersPolicy[]): SudoersPolicy {
  const merged = emptyPolicy();
  for (const p of policies) {
    if (!p) continue;
    merged.cmnd.push(...p.cmnd);
    merged.read.push(...p.read);
    merged.write.push(...p.write);
    merged.export.push(...(p.export ?? []));
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

/**
 * Match a transcript-export subject against the policy's `Export` rules.
 * Exports are always gated, so the only two outcomes are `nopasswd-allow`
 * (a matching grant — skip the prompt) and `require-approval`.
 */
export function matchExport(policy: SudoersPolicy, subject: string): MatchResult {
  return resolve(policy.export ?? [], subject) === 'nopasswd-allow'
    ? 'nopasswd-allow'
    : 'require-approval';
}

/** Match a single command segment against the policy's `Cmnd` rules. */
export function matchCommand(policy: SudoersPolicy, segment: string): MatchResult {
  return resolve(policy.cmnd, segment.trim());
}

/** Whether a write to `normalized` hits the hardcoded self-protection invariant. */
function isSelfProtectedWrite(normalized: string): boolean {
  return (
    normalized === SUDOERS_FILE ||
    normalized === APPROVALS_FILE ||
    normalized === SUDOERS_D_DIR ||
    normalized.startsWith(`${SUDOERS_D_DIR}/`) ||
    normalized === PROTECTED_LAYOUTS_DIR ||
    normalized.startsWith(`${PROTECTED_LAYOUTS_DIR}/`)
  );
}

/**
 * Match a read/write to `path` against the policy. Writes to `/etc/sudoers`,
 * anything under `/etc/sudoers.d/`, or anything under `/etc/slicc/layouts/`
 * ALWAYS require approval, regardless of configuration — `NOPASSWD` cannot
 * override the invariant. Reads of those files are allowed (visudo-style) and
 * fall through to normal matching.
 *
 * Writes to a sudoers-shaped path SLICC does not honour as policy
 * ({@link isUnhonoredSudoersPath} — the per-scoop
 * `/scoops/<folder>/etc/sudoers` shapes) are `deny`: refused outright, with no
 * approval raised. Checked before self-protection, because a hard refusal
 * beats a prompt an approver could answer wrongly.
 *
 * Writes to no-op virtual device files (`/dev/null`, see `virtual-device-paths.ts`)
 * are auto-permitted regardless of policy or default disposition ONLY for CONTENT
 * writes (`writeFile`, marked via `opts.isContentWrite`) — the payload is
 * discarded, so there is nothing to approve. Structural ops routed through the
 * `write` gate (`mkdir`/`rm`/`rename`/`symlink`/`copyFile`) are NOT content
 * writes: they mutate the tree rather than discarding a payload, so they fall
 * through to normal matching and can still be gated. Reads of those paths are
 * unaffected and fall through to normal matching.
 */
export function matchPath(
  policy: SudoersPolicy,
  op: PathOp,
  path: string,
  opts?: { isContentWrite?: boolean }
): MatchResult {
  const normalized = normalizePath(path);
  if (op === 'write') {
    if (SCOOP_SUDOERS_RE.test(normalized)) return 'deny';
    if (isSelfProtectedWrite(normalized)) return 'require-approval';
    if (opts?.isContentWrite && isNoOpWriteDevicePath(normalized)) return 'nopasswd-allow';
  }
  // The shell's ephemeral descriptors (`/dev/fd/<n>`, minted per command by
  // process substitution) are never a policy subject: the fd number changes
  // every invocation, so no "Always" grant could pre-empt the prompt, and an
  // unattended scoop would stall forever on a cone approval for a path its
  // own next command would read straight back (#2502). Exempt for BOTH ops —
  // the write is the one that escalates today, but an explicit `Read` rule
  // must not be able to gate the consumer's open either. Self-protection is
  // checked first and stays absolute.
  //
  // Unlike the `/dev/null` exemption above, this one is deliberately NOT
  // limited to content writes: a prompt is the wrong answer for a descriptor
  // whatever the op is. Containment for the STRUCTURAL ops (`mkdir`, `symlink`,
  // `rename`, `mount`) lives in the other layer instead, where it belongs —
  // `RestrictedFS.refuseDescriptorTreeOp` rejects them outright, so the two
  // layers still agree that no op on a descriptor path may create a shared-tree
  // entry.
  if (isEphemeralFdPath(normalized)) return 'nopasswd-allow';
  return resolve(op === 'read' ? policy.read : policy.write, normalized);
}
