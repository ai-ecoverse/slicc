/**
 * Workflow discovery — scan VirtualFS for `*.workflow.js` files and build a map of
 * command name → entry. Saved workflows (`/workspace/.workflows/`) get the bare stem;
 * skill-bundled workflows (`/workspace/skills/<skill>/.workflows/`) get `<skill>:<stem>`
 * (collision-free — `:` is outside the skill/workflow name charset). Skill segments are
 * validated against VALID_SKILL_NAME and skipped (with a warning) when they contain a
 * reserved char, so a raw directory name can never break the `<skill>:<name>` contract.
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
// Same charset install-from-drop.ts enforces for skill dirs; a `:` (or other reserved
// char) would break the `<skill>:<name>` namespace, so such dirs are skipped.
const VALID_SKILL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

  // Saved workflows → bare names.
  if (await fs.exists(SAVED_ROOT)) {
    for await (const path of fs.walk(SAVED_ROOT)) {
      if (!path.endsWith(SUFFIX)) continue;
      const name = stem(path);
      if (name && !out.has(name)) out.set(name, { path, kind: 'saved' });
    }
  }

  // Skill-bundled workflows → `<skill>:<name>` (always namespaced).
  if (await fs.exists(SKILLS_ROOT)) {
    for await (const path of fs.walk(SKILLS_ROOT)) {
      if (!path.endsWith(SUFFIX)) continue;
      const skill = skillSegment(path);
      if (!skill) continue;
      if (!VALID_SKILL_SEGMENT.test(skill)) {
        log.warn(`skipping workflow under invalid skill dir name: ${skill} (${path})`);
        continue;
      }
      const name = `${skill}:${stem(path)}`;
      if (!out.has(name)) out.set(name, { path, kind: 'skill', skill });
    }
  }

  return out;
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
 * a `workflow run` flag; `--` forces the remainder to be treated as literal positionals.
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
