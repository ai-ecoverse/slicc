import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/index.js';
import { WasmShell } from '../shell/index.js';
import { createBashTool } from './bash-tool.js';
import type { ToolDefinition } from '../core/types.js';

describe('Bash Tool', () => {
  let fs: VirtualFS;
  let shell: WasmShell;
  let bash: ToolDefinition;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      backend: 'indexeddb',
      dbName: `test-bash-tool-${dbCounter++}`,
    });
    shell = new WasmShell({ fs });
    bash = createBashTool(shell);
  });

  it('has correct name and description', () => {
    expect(bash.name).toBe('bash');
    expect(bash.description).toBeTruthy();
  });

  it('executes echo', async () => {
    const result = await bash.execute({ command: 'echo hello world' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello world');
  });

  it('executes pwd', async () => {
    const result = await bash.execute({ command: 'pwd' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('/');
  });

  it('reports errors with isError', async () => {
    const result = await bash.execute({ command: 'cat /nonexistent' });
    expect(result.isError).toBe(true);
  });

  it('supports pipe commands', async () => {
    await fs.writeFile('/data.txt', 'apple\nbanana\ncherry');
    const result = await bash.execute({ command: 'cat /data.txt | grep banana' });
    expect(result.content).toContain('banana');
    expect(result.content).not.toContain('apple');
  });

  it('supports file creation and reading', async () => {
    await bash.execute({ command: 'echo "test content" > /test.txt' });
    const result = await bash.execute({ command: 'cat /test.txt' });
    expect(result.content).toContain('test content');
  });

  it('handles empty output', async () => {
    const result = await bash.execute({ command: 'mkdir /newdir' });
    // mkdir produces no stdout, so output falls back to exit code
    expect(result.content).toContain('exit code: 0');
  });
});
