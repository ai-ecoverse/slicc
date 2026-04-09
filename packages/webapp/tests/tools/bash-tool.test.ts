import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { WasmShell } from '../../src/shell/index.js';
import { createBashTool } from '../../src/tools/bash-tool.js';
import type { ToolDefinition } from '../../src/core/types.js';

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

  afterEach(async () => {
    await fs.dispose();
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
    const unzipResult = await bash.execute({
      command: 'unzip /archive/out.zip -d /archive/extract',
    });
    expect(unzipResult.isError).toBeFalsy();
    expect(unzipResult.content).toContain('/archive/extract');

    const aResult = await bash.execute({ command: 'cat /archive/extract/archive/src/a.txt' });
    expect(aResult.isError).toBeFalsy();
    expect(aResult.content).toContain('alpha');
  });

  it('supports sqlite3 file-backed queries', async () => {
    const result = await bash.execute({
      command:
        'sqlite3 /data/test.db "create table if not exists users(name text); insert into users values (\'alice\'); select name from users;"',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('alice');

    const dbExists = await fs.exists('/data/test.db');
    expect(dbExists).toBe(true);

    const aliasResult = await bash.execute({
      command: 'sqllite /data/test.db "select name from users;"',
    });
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

  it('keeps playwright aliases discoverable through real shell surfaces without browser support', async () => {
    const which = await bash.execute({ command: 'which playwright-cli' });
    expect(which.isError).toBeFalsy();
    expect(which.content).toContain('/usr/bin/playwright-cli');

    const usrBin = await bash.execute({ command: 'ls /usr/bin | grep playwright' });
    expect(usrBin.isError).toBeFalsy();
    expect(usrBin.content).toContain('playwright');
    expect(usrBin.content).toContain('playwright-cli');

    const commands = await bash.execute({ command: 'commands | grep playwright' });
    expect(commands.isError).toBeFalsy();
    expect(commands.content).toContain('playwright-cli');
    expect(commands.content).toContain('puppeteer');

    const open = await bash.execute({ command: 'playwright-cli open https://example.com' });
    expect(open.isError).toBe(true);
    expect(open.content).toContain('browser APIs are unavailable');
  });

  it('exposes playwright aliases like normal shell commands when browser support is available', async () => {
    const browserShell = new WasmShell({ fs, browserAPI: {} as any });
    const browserBash = createBashTool(browserShell);

    const help = await browserBash.execute({ command: 'playwright --help' });
    expect(help.isError).toBeFalsy();
    expect(help.content).toContain('Usage: playwright <command>');

    const which = await browserBash.execute({
      command: 'which playwright playwright-cli puppeteer',
    });
    expect(which.isError).toBeFalsy();
    expect(which.content).toContain('/usr/bin/playwright\n');
    expect(which.content).toContain('/usr/bin/playwright-cli\n');
    expect(which.content).toContain('/usr/bin/puppeteer\n');

    const commands = await browserBash.execute({ command: 'commands' });
    expect(commands.isError).toBeFalsy();
    expect(commands.content).toContain(
      'open, imgcat, playwright-cli, playwright, puppeteer, webhook'
    );

    const usrBin = await browserBash.execute({ command: 'ls /usr/bin' });
    expect(usrBin.isError).toBeFalsy();
    expect(usrBin.content).toContain('playwright');
    expect(usrBin.content).toContain('playwright-cli');
    expect(usrBin.content).toContain('puppeteer');
  });
});
