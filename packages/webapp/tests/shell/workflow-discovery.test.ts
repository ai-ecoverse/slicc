import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/index.js';
import {
  buildWorkflowRunArgv,
  discoverWorkflowCommands,
} from '../../src/shell/workflow-discovery.js';

async function fsWith(files: Record<string, string>): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `wfd-${Math.random()}`, wipe: true });
  for (const [path, content] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, content);
  }
  return fs;
}

describe('discoverWorkflowCommands', () => {
  it('discovers a saved workflow as a bare command name', async () => {
    const fs = await fsWith({ '/workspace/.workflows/weekly-audit.workflow.js': 'return 1' });
    const map = await discoverWorkflowCommands(fs);
    expect(map.get('weekly-audit')).toEqual({
      path: '/workspace/.workflows/weekly-audit.workflow.js',
      kind: 'saved',
    });
  });

  it('discovers a skill workflow as <skill>:<name>', async () => {
    const fs = await fsWith({
      '/workspace/skills/triage/.workflows/sweep.workflow.js': 'return 1',
    });
    const map = await discoverWorkflowCommands(fs);
    expect(map.get('triage:sweep')).toEqual({
      path: '/workspace/skills/triage/.workflows/sweep.workflow.js',
      kind: 'skill',
      skill: 'triage',
    });
    expect(map.has('sweep')).toBe(false); // never bare
  });

  it('skips a skill dir whose name has a reserved char', async () => {
    const fs = await fsWith({ '/workspace/skills/bad:name/.workflows/x.workflow.js': 'return 1' });
    const map = await discoverWorkflowCommands(fs);
    expect(map.size).toBe(0);
  });

  it('ignores a skill *.workflow.js outside the .workflows dir', async () => {
    const fs = await fsWith({ '/workspace/skills/triage/scripts/x.workflow.js': 'return 1' });
    const map = await discoverWorkflowCommands(fs);
    expect(map.size).toBe(0);
  });

  it('ignores non-.workflow.js files', async () => {
    const fs = await fsWith({ '/workspace/.workflows/notes.md': 'hi' });
    const map = await discoverWorkflowCommands(fs);
    expect(map.size).toBe(0);
  });
});

describe('buildWorkflowRunArgv', () => {
  const P = '/workspace/.workflows/w.workflow.js';
  it('no args → workflow run <path>', () => {
    expect(buildWorkflowRunArgv(P, [])).toEqual(['workflow', 'run', P]);
  });
  it('single JSON-valid arg → --args verbatim', () => {
    expect(buildWorkflowRunArgv(P, ['123'])).toEqual(['workflow', 'run', P, '--args', '123']);
    expect(buildWorkflowRunArgv(P, ['{"a":1}'])).toEqual([
      'workflow',
      'run',
      P,
      '--args',
      '{"a":1}',
    ]);
  });
  it('single non-JSON arg → JSON-stringified string', () => {
    expect(buildWorkflowRunArgv(P, ['abc'])).toEqual(['workflow', 'run', P, '--args', '"abc"']);
  });
  it('multiple args → JSON string array', () => {
    expect(buildWorkflowRunArgv(P, ['a', 'b'])).toEqual([
      'workflow',
      'run',
      P,
      '--args',
      '["a","b"]',
    ]);
  });
  it('extracts --wait and passes it through', () => {
    expect(buildWorkflowRunArgv(P, ['--wait', '123'])).toEqual([
      'workflow',
      'run',
      P,
      '--wait',
      '--args',
      '123',
    ]);
  });
  it('-- forces the rest as literal positionals', () => {
    expect(buildWorkflowRunArgv(P, ['--', '--wait'])).toEqual([
      'workflow',
      'run',
      P,
      '--args',
      '"--wait"',
    ]);
  });
});
