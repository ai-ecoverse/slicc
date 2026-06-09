/**
 * Workflow discovery — scan VirtualFS for `*.workflow.js` files and build a map of
 * command name → entry. Saved workflows (`/workspace/.workflows/`) get the bare stem;
 * skill-bundled workflows (`/workspace/skills/<skill>/.workflows/`) get `<skill>:<stem>`
 * (collision-free — `:` is outside the skill/workflow name charset). Both the skill segment
 * and the workflow stem are validated against `VALID_NAME_SEGMENT` (the same charset
 * `install-from-drop.ts`'s `VALID_SKILL_NAME` enforces) and skipped (with a warning) on a
 * reserved char, so a raw filename can never break the `<skill>:<name>` contract or register
 * an undispatchable command name.
 *
 * Mirrors jsh-discovery.ts (first occurrence of a name wins). Naming model + precedence
 * are specified in docs/superpowers/specs/2026-06-08-workflow-authoring-design.md §3.
 */

import { createLogger } from '../core/logger.js';
import type { JshDiscoveryFS } from './jsh-discovery.js';

const log = createLogger('workflow-discovery');

const SAVED_ROOT = '/workspace/.workflows';
const SKILLS_ROOT = '/workspace/skills';
const SUFFIX = '.workflow.js';
// Valid command-name segment (same charset install-from-drop.ts enforces for skill dirs).
// Applied to BOTH the skill segment AND the workflow stem so the discovery layer is the
// single source of truth for "what is a valid workflow command name" — `workflow save`
// already enforces this, but a file placed by other means (manual `cp`, `git checkout`,
// hand-editing) must not register an undispatchable name (spaces, `:`, `/`, …) or one
// that breaks the `<skill>:<name>` namespace.
const VALID_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface WorkflowCommandEntry {
  path: string;
  kind: 'saved' | 'skill';
  skill?: string;
}

/** Discover every `*.workflow.js` and return command name → entry. First wins. */
export async function discoverWorkflowCommands(
  fs: JshDiscoveryFS
): Promise<Map<string, WorkflowCommandEntry>> {
  const out = new Map<string, WorkflowCommandEntry>();
  // Contain a walk failure (e.g. a directory that becomes unreadable mid-scan) so a corrupt
  // subtree under one root doesn't reject the whole discovery — that would make every
  // workflow command silently vanish and surface as a raw rejection in callers (e.g. the
  // `workflow save` re-sync). Log + return what we collected; each root is independent.
  try {
    if (await fs.exists(SAVED_ROOT)) await scanSavedRoot(fs, out);
  } catch (err) {
    log.warn(`workflow discovery: ${SAVED_ROOT} scan failed`, err);
  }
  try {
    if (await fs.exists(SKILLS_ROOT)) await scanSkillsRoot(fs, out);
  } catch (err) {
    log.warn(`workflow discovery: ${SKILLS_ROOT} scan failed`, err);
  }
  return out;
}

/** Saved workflows (`/workspace/.workflows/`) → bare command names. */
async function scanSavedRoot(
  fs: JshDiscoveryFS,
  out: Map<string, WorkflowCommandEntry>
): Promise<void> {
  for await (const path of fs.walk(SAVED_ROOT)) {
    if (!path.endsWith(SUFFIX)) continue;
    const name = stem(path);
    if (!VALID_NAME_SEGMENT.test(name)) {
      log.warn(`skipping saved workflow with invalid command name: '${name}' (${path})`);
      continue;
    }
    if (!out.has(name)) out.set(name, { path, kind: 'saved' });
  }
}

/** Skill-bundled workflows (`/workspace/skills/<skill>/.workflows/`) → `<skill>:<name>`. */
async function scanSkillsRoot(
  fs: JshDiscoveryFS,
  out: Map<string, WorkflowCommandEntry>
): Promise<void> {
  for await (const path of fs.walk(SKILLS_ROOT)) {
    if (!path.endsWith(SUFFIX)) continue;
    const skill = skillSegment(path);
    if (!skill) continue;
    const name = stem(path);
    if (!VALID_NAME_SEGMENT.test(skill) || !VALID_NAME_SEGMENT.test(name)) {
      log.warn(`skipping skill workflow with invalid name segment: '${skill}:${name}' (${path})`);
      continue;
    }
    const qualified = `${skill}:${name}`;
    if (!out.has(qualified)) out.set(qualified, { path, kind: 'skill', skill });
  }
}

/** `/a/b/foo.workflow.js` → `foo` (basename minus the `.workflow.js` suffix). */
function stem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.endsWith(SUFFIX) ? base.slice(0, -SUFFIX.length) : base;
}

/**
 * For `/workspace/skills/<skill>/.workflows/x.workflow.js` → `<skill>`; else `null`.
 * REQUIRES the `.workflows/` segment so a stray `*.workflow.js` elsewhere in a skill
 * (e.g. `skills/foo/scripts/x.workflow.js`) is NOT picked up.
 */
function skillSegment(path: string): string | null {
  const rest = path.slice(SKILLS_ROOT.length + 1); // strip "/workspace/skills/"
  const parts = rest.split('/'); // [<skill>, '.workflows', …, 'x.workflow.js']
  return parts.length >= 3 && parts[1] === '.workflows' ? parts[0] : null;
}

/**
 * Coerce a bare workflow-command invocation (`<name> [args…]`) into a `workflow run`
 * argv. Arg coercion is intentionally MORE LENIENT than `workflow run --args` (which is
 * strict JSON): a single arg is passed verbatim when it parses as JSON, else JSON-string-
 * wrapped; multiple args → a JSON string array; none → no `--args`. `--wait` is lifted to
 * a `workflow run` flag wherever it appears *before* `--`; after `--` (literal mode) a
 * `--wait` token is treated as a literal positional like everything else. So pass
 * `<name> -- --wait` to feed a literal `--wait` arg rather than blocking.
 */
export function buildWorkflowRunArgv(path: string, rawArgs: string[]): string[] {
  let wait = false;
  const positionals: string[] = [];
  let literal = false;
  for (const a of rawArgs) {
    if (literal) {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      literal = true;
      continue;
    }
    if (a === '--wait') {
      wait = true;
      continue;
    }
    positionals.push(a);
  }

  const argv = ['workflow', 'run', path];
  if (wait) argv.push('--wait');

  if (positionals.length === 1) {
    argv.push('--args', asJsonArg(positionals[0]));
  } else if (positionals.length > 1) {
    argv.push('--args', JSON.stringify(positionals));
  }
  return argv;
}

/** A single token: pass through if it parses as JSON, else JSON-stringify it as a string. */
function asJsonArg(token: string): string {
  try {
    JSON.parse(token);
    return token;
  } catch {
    return JSON.stringify(token);
  }
}
