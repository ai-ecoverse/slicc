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
      dbName: `test-bash-tool-${dbCounter++}`,
      wipe: true,
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

  it('does not report grep no-match searches as errors', async () => {
    await fs.writeFile('/data.txt', 'apple\nbanana\ncherry');

    const result = await bash.execute({ command: 'cat /data.txt | grep dragonfruit' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('exit code: 1');
  });

  it('does not report rg no-match searches as errors', async () => {
    await bash.execute({ command: 'mkdir -p /workspace/src' });
    await bash.execute({ command: 'echo "const foo = 1" > /workspace/src/main.ts' });

    const result = await bash.execute({ command: 'rg "bar" /workspace/src' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('exit code: 1');
  });

  it('supports find through the shell', async () => {
    await bash.execute({ command: 'mkdir -p /workspace/src /workspace/docs' });
    await bash.execute({ command: 'echo "console.log(1)" > /workspace/src/main.ts' });
    await bash.execute({ command: 'echo "# hello" > /workspace/docs/readme.md' });

    const result = await bash.execute({ command: 'find /workspace -name "*.ts" -type f' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('/workspace/src/main.ts');
    expect(result.content).not.toContain('/workspace/docs/readme.md');
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

  it('supports zip and unzip commands', async () => {
    await bash.execute({ command: 'mkdir -p /archive/src' });
    await bash.execute({ command: 'echo "alpha" > /archive/src/a.txt' });
    await bash.execute({ command: 'echo "beta" > /archive/src/b.txt' });

    const zipResult = await bash.execute({ command: 'zip -r /archive/out.zip /archive/src' });
    expect(zipResult.isError).toBeFalsy();
    expect(zipResult.content).toContain('/archive/out.zip');

    await bash.execute({ command: 'mkdir -p /archive/extract' });
    const unzipResult = await bash.execute({ command: 'unzip /archive/out.zip -d /archive/extract' });
    expect(unzipResult.isError).toBeFalsy();
    expect(unzipResult.content).toContain('/archive/extract');

    const aResult = await bash.execute({ command: 'cat /archive/extract/archive/src/a.txt' });
    expect(aResult.isError).toBeFalsy();
    expect(aResult.content).toContain('alpha');
  });

  it('supports sqlite3 file-backed queries', async () => {
    const result = await bash.execute({
      command: 'sqlite3 /data/test.db "create table if not exists users(name text); insert into users values (\'alice\'); select name from users;"',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('alice');

    const dbExists = await fs.exists('/data/test.db');
    expect(dbExists).toBe(true);

    const aliasResult = await bash.execute({ command: 'sqllite /data/test.db "select name from users;"' });
    expect(aliasResult.isError).toBeFalsy();
    expect(aliasResult.content).toContain('alice');
  });

  it('supports node -e execution', async () => {
    const result = await bash.execute({ command: 'node -e "console.log(1 + 2)"' });
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe('3');
  });

  it('supports python3 -c execution', async () => {
    const result = await bash.execute({ command: 'python3 -c "print(1 + 1)"' });
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe('2');
  }, 120000);

  it('supports open command (non-browser fallback)', async () => {
    const result = await bash.execute({ command: 'open https://example.com' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('browser APIs are unavailable');
  });
});
