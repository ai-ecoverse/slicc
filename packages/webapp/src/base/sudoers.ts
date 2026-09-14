import { normalizePath, pathGlobToRegExp } from '../fs/path-utils.js';
import { isEphemeralFdPath, isNoOpWriteDevicePath } from '../fs/virtual-device-paths.js';
import { createLogger } from './logger.js';

export { pathGlobToRegExp } from '../fs/path-utils.js';

const log = createLogger('sudo:sudoers');

export type MatchResult = 'require-approval' | 'nopasswd-allow' | 'no-match';

export type PathOp = 'read' | 'write';

export interface SudoersRule {
  pattern: string;

  nopasswd: boolean;

  regex: RegExp;
}

export interface SudoersPolicy {
  cmnd: SudoersRule[];
  read: SudoersRule[];
  write: SudoersRule[];

  export: SudoersRule[];
}

export const SUDOERS_FILE = '/etc/sudoers';

export const SUDOERS_D_DIR = '/etc/sudoers.d';

export const APPROVALS_FILE = '/etc/APPROVALS.md';

const SCOOP_SUDOERS_RE = /^\/scoops\/[^/]+\/etc\/sudoers$/;

export const PROTECTED_LAYOUTS_DIR = '/etc/slicc/layouts';

export function scoopSudoersPath(folder: string): string {
  return `/scoops/${folder}/etc/sudoers`;
}

export type DefaultDisposition = 'allow' | 'require-approval';

export function applyDefaultDisposition(
  match: MatchResult,
  defaultDisposition: DefaultDisposition
): MatchResult {
  if (match !== 'no-match') return match;
  return defaultDisposition === 'require-approval' ? 'require-approval' : 'no-match';
}

export function emptyPolicy(): SudoersPolicy {
  return { cmnd: [], read: [], write: [], export: [] };
}

function escapeRegExpChar(ch: string): string {
  return '.+^$()[]|\\{}'.includes(ch) ? `\\${ch}` : ch;
}

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

  return new RegExp(`^${re}$`, 's');
}

export function sanitizeGrantPattern(pattern: string): string {
  return pattern.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

const DIRECTIVES = new Set(['Cmnd', 'Read', 'Write', 'Export']);

export type Directive = 'Cmnd' | 'Read' | 'Write' | 'Export';

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

const BUILTIN_SCOOP_GRANTS = [
  'NOPASSWD Read /tmp',
  'NOPASSWD Read /tmp/**',
  'NOPASSWD Write /tmp',
  'NOPASSWD Write /tmp/**',
].join('\n');

let builtinScoopPolicy: SudoersPolicy | null = null;

export function builtinScoopGrants(): SudoersPolicy {
  builtinScoopPolicy ??= parseSudoers(BUILTIN_SCOOP_GRANTS);
  return builtinScoopPolicy;
}

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

export function matchExport(policy: SudoersPolicy, subject: string): MatchResult {
  return resolve(policy.export ?? [], subject) === 'nopasswd-allow'
    ? 'nopasswd-allow'
    : 'require-approval';
}

export function matchCommand(policy: SudoersPolicy, segment: string): MatchResult {
  return resolve(policy.cmnd, segment.trim());
}

function isSelfProtectedWrite(normalized: string): boolean {
  return (
    normalized === SUDOERS_FILE ||
    normalized === APPROVALS_FILE ||
    normalized === SUDOERS_D_DIR ||
    normalized.startsWith(`${SUDOERS_D_DIR}/`) ||
    SCOOP_SUDOERS_RE.test(normalized) ||
    normalized === PROTECTED_LAYOUTS_DIR ||
    normalized.startsWith(`${PROTECTED_LAYOUTS_DIR}/`)
  );
}

export function matchPath(
  policy: SudoersPolicy,
  op: PathOp,
  path: string,
  opts?: { isContentWrite?: boolean }
): MatchResult {
  const normalized = normalizePath(path);
  if (op === 'write') {
    if (isSelfProtectedWrite(normalized)) return 'require-approval';
    if (opts?.isContentWrite && isNoOpWriteDevicePath(normalized)) return 'nopasswd-allow';
  }

  if (isEphemeralFdPath(normalized)) return 'nopasswd-allow';
  return resolve(op === 'read' ? policy.read : policy.write, normalized);
}
