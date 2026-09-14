import { createLogger } from '../base/logger.js';
import type { JshDiscoveryFS } from './jsh-discovery.js';

const log = createLogger('workflow-discovery');

const SAVED_ROOT = '/workspace/.workflows';
const SKILLS_ROOT = '/workspace/skills';

export const WORKFLOW_DISCOVERY_ROOTS = [SAVED_ROOT, SKILLS_ROOT] as const;
const SUFFIX = '.workflow.js';

const VALID_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface WorkflowCommandEntry {
  path: string;
  kind: 'saved' | 'skill';
  skill?: string;
}

export async function discoverWorkflowCommands(
  fs: JshDiscoveryFS
): Promise<Map<string, WorkflowCommandEntry>> {
  const out = new Map<string, WorkflowCommandEntry>();

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

function stem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.endsWith(SUFFIX) ? base.slice(0, -SUFFIX.length) : base;
}

function skillSegment(path: string): string | null {
  const rest = path.slice(SKILLS_ROOT.length + 1);
  const parts = rest.split('/');
  return parts.length >= 3 && parts[1] === '.workflows' ? parts[0] : null;
}

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

function asJsonArg(token: string): string {
  try {
    JSON.parse(token);
    return token;
  } catch {
    return JSON.stringify(token);
  }
}
