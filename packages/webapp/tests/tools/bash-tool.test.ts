import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RestrictedFS, VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShell } from '../../src/shell/index.js';
import {
  createBashTool,
  DEFAULT_BASH_BACKGROUND_AFTER_SECONDS,
  splitCommandSegments,
} from '../../src/tools/bash-tool.js';
import type { BashJobHost, ToolDefinition } from '../../src/tools/types.js';

describe('splitCommandSegments', () => {
  it('splits on ;, |, && and ||', () => {
    const segments = splitCommandSegments('a | b && c || d ; e')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(segments).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('splits "a || b" into two segments with no spurious empty segment', () => {
    expect(splitCommandSegments('a || b').map((s) => s.trim())).toEqual(['a', 'b']);
  });

  it('does not split a lone & (background)', () => {
    expect(splitCommandSegments('git push & echo done').map((s) => s.trim())).toEqual([
      'git push & echo done',
    ]);
  });

  it('ignores separators inside quotes and after escapes', () => {
    expect(splitCommandSegments('echo "a | b" ; ls').map((s) => s.trim())).toEqual([
      'echo "a | b"',
      'ls',
    ]);
    expect(splitCommandSegments('echo a\\|b').map((s) => s.trim())).toEqual(['echo a\\|b']);
  });

  it('returns a trailing empty segment after a final separator', () => {
    const segs = splitCommandSegments('ls |');
    expect((segs[segs.length - 1] ?? '').trim()).toBe('');
  });
});

describe('Bash Tool', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShell;
  let bash: ToolDefinition;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-bash-tool-${dbCounter++}`,
      wipe: true,
    });
    shell = new AlmostBashShell({ fs });
    bash = createBashTool(shell, fs, '/tmp');
  });

  it('has correct name and description', () => {
    expect(bash.name).toBe('bash');
    expect(bash.description).toBeTruthy();
  });

  it('caps oversized output at 40KB and writes the full output to a temp file (#2010)', async () => {
    const big = 'y'.repeat(60 * 1024); // 60KB — over the 40KB cap
    await fs.writeFile('/big.txt', big);

    const result = await bash.execute({ command: 'cat /big.txt' });

    // Returned content is bounded well under the raw 60KB, with a truncation footer.
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeLessThan(60 * 1024);
    expect(result.content).toContain('Output truncated');
    const pathMatch = result.content.match(/\/tmp\/bash-output-\d+\.txt/);
    expect(pathMatch).not.toBeNull();

    // The full, untruncated output is retrievable from the temp file for paging.
    const full = await fs.readFile(pathMatch![0], { encoding: 'utf-8' });
    expect(typeof full === 'string' ? full.length : 0).toBeGreaterThanOrEqual(60 * 1024);
  });

  it('carries an oversized image marker past the 40KB text cap intact (#2217)', async () => {
    // `open --view` emits the image as a `<img:data:…>` marker in bash output.
    // Tail-truncating through it left the model with a base64 tail and no
    // image, and cost the chat row its inline preview.
    const marker = `<img:data:image/png;base64,${'A'.repeat(200 * 1024)}>`;
    await fs.writeFile('/shot.txt', `/shared/shot.png (1536x1506, 198 KB, image/png)\n${marker}`);

    const result = await bash.execute({ command: 'cat /shot.txt' });

    expect(result.content).toContain(marker);
    expect(result.content).toContain('/shared/shot.png (1536x1506, 198 KB, image/png)');
    // The marker alone is over the cap, yet the text around it is not truncated.
    expect(result.content).not.toContain('Output truncated');
  });

  it('keeps the image marker in place when the surrounding text IS truncated (#2217)', async () => {
    const marker = `<img:data:image/png;base64,${'A'.repeat(1024)}>`;
    await fs.writeFile('/mixed.txt', `${'y'.repeat(60 * 1024)}\nshot.png\n${marker}`);

    const result = await bash.execute({ command: 'cat /mixed.txt' });

    expect(result.content).toContain('Output truncated');
    expect(result.content).toContain(marker);
    // The image still follows the line that introduced it, not the footer.
    expect(result.content.indexOf('shot.png')).toBeLessThan(result.content.indexOf(marker));
    // The paging file holds the text, with the base64 replaced by a stub.
    const path = result.content.match(/\/tmp\/bash-output-\d+\.txt/)?.[0];
    const full = await fs.readFile(path!, { encoding: 'utf-8' });
    expect(full).not.toContain('<img:');
    expect(full).toContain('[image]');
  });

  it('drops the oldest images over the 1MB image budget (#2217)', async () => {
    // Each marker is ~600KB, so only the newest fits the budget.
    const first = `<img:data:image/png;base64,${'A'.repeat(600 * 1024)}>`;
    const second = `<img:data:image/png;base64,${'B'.repeat(600 * 1024)}>`;
    await fs.writeFile('/two.txt', `one\n${first}\ntwo\n${second}`);

    const result = await bash.execute({ command: 'cat /two.txt' });

    expect(result.content).not.toContain(first);
    expect(result.content).toContain(second);
    expect(result.content).toContain('image dropped');
  });

  it('keeps a single image that alone exceeds the budget (#2224 review)', async () => {
    // The budget bounds accumulation, not one deliberately-requested image:
    // `open --view --size high` on a photo can pass 1MB by itself, and dropping
    // it would just move #2217's failure from "truncated" to "gone".
    const huge = `<img:data:image/png;base64,${'A'.repeat(1200 * 1024)}>`;
    await fs.writeFile('/huge.txt', `photo.png\n${huge}`);

    const result = await bash.execute({ command: 'cat /huge.txt' });

    expect(result.content).toContain(huge);
    expect(result.content).not.toContain('image dropped');
  });

  it('still truncates a marker-shaped run that is not a usable image (#2217)', async () => {
    // Prose quoting the syntax carries no payload, so it stays subject to the
    // text cap — exempting it would be a cap bypass.
    await fs.writeFile('/prose.txt', `<img:data:image/${'x'.repeat(60 * 1024)}>`);

    const result = await bash.execute({ command: 'cat /prose.txt' });

    expect(result.content).toContain('Output truncated');
    expect(result.content.length).toBeLessThan(60 * 1024);
  });

  it('leaves small output unchanged (no truncation footer)', async () => {
    const result = await bash.execute({ command: 'echo hello world' });
    expect(result.content).toContain('hello world');
    expect(result.content).not.toContain('Output truncated');
  });

  it('writes the paging file into an injected scoop temp dir readable via the same sandbox (#2010 P2)', async () => {
    // Simulate a scoop sandbox: writable+readable only under /scoops/<folder>/ and
    // /shared/ — NOT /tmp. Codex flagged that a hardcoded /tmp path is unusable
    // for scoops (RestrictedFS rejects the write/read). The tool must write into
    // the injected, context-accessible temp dir instead.
    await fs.mkdir('/scoops/andy-scoop', { recursive: true });
    const restricted = new RestrictedFS(fs, ['/scoops/andy-scoop/', '/shared/']);
    const scoopShell = new AlmostBashShell({ fs: restricted as unknown as VirtualFS });
    const scoopBash = createBashTool(
      scoopShell,
      restricted as unknown as VirtualFS,
      '/scoops/andy-scoop'
    );

    await restricted.writeFile('/scoops/andy-scoop/big.txt', 'z'.repeat(60 * 1024));
    const result = await scoopBash.execute({ command: 'cat /scoops/andy-scoop/big.txt' });

    expect(result.content).toContain('Output truncated');
    const path = result.content.match(/\/scoops\/andy-scoop\/bash-output-\d+\.txt/)?.[0];
    expect(path).toBeTruthy();
    // The follow-up read the footer advertises actually works inside the sandbox.
    const full = await restricted.readFile(path!, { encoding: 'utf-8' });
    expect(typeof full === 'string' ? full.length : 0).toBeGreaterThanOrEqual(60 * 1024);
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
    const browserShell = new AlmostBashShell({ fs, browserAPI: {} as any });
    const browserBash = createBashTool(browserShell, fs, '/tmp');

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
      'open, imgcat, playwright-cli, playwright, puppeteer, sprinkle'
    );

    const usrBin = await browserBash.execute({ command: 'ls /usr/bin' });
    expect(usrBin.isError).toBeFalsy();
    expect(usrBin.content).toContain('playwright');
    expect(usrBin.content).toContain('playwright-cli');
    expect(usrBin.content).toContain('puppeteer');
  });
});

/**
 * A shell whose command never finishes until the test says so — the only way to
 * exercise the detach / timeout races deterministically. Records the signal each
 * run received so a test can assert the hard kill actually reached the shell.
 */
function pendingShell() {
  const signals: (AbortSignal | undefined)[] = [];
  const shellPids: (number | undefined)[] = [];
  let settle!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
  let fail!: (err: Error) => void;
  const shell = {
    executeCommand: (_command: string, signal?: AbortSignal, shellPid?: number) => {
      signals.push(signal);
      shellPids.push(shellPid);
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((res, rej) => {
        settle = res;
        fail = rej;
      });
    },
  };
  return {
    shell: shell as unknown as AlmostBashShell,
    signals,
    shellPids,
    settle: (result: { stdout: string; stderr: string; exitCode: number }) => settle(result),
    fail: (err: Error) => fail(err),
  };
}

/**
 * A {@link BashJobHost} that records what the tool did to each job, without a
 * real `ProcessManager` (the PM cascade itself is covered by
 * `tests/tools/bash-job-process.test.ts`).
 */
function fakeJobHost(startPid = 4000) {
  const jobs: {
    pid: number;
    command: string;
    killed: number;
    exits: (number | null)[];
    controller: AbortController;
  }[] = [];
  const host: BashJobHost = {
    spawn: (command) => {
      const controller = new AbortController();
      const entry = {
        pid: startPid + jobs.length,
        command,
        killed: 0,
        exits: [] as (number | null)[],
        controller,
      };
      jobs.push(entry);
      return {
        pid: entry.pid,
        signal: controller.signal,
        kill: () => {
          entry.killed += 1;
          controller.abort();
        },
        exit: (code: number | null) => entry.exits.push(code),
      };
    },
  };
  return { host, jobs };
}

describe('Bash Tool background_after / timeout', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-bash-bg-${dbCounter++}`, wipe: true });
  });

  it('advertises both knobs and the configured default in its schema', () => {
    const bash = createBashTool(new AlmostBashShell({ fs }), fs, '/tmp', {
      defaultBackgroundAfterSeconds: 42,
    });
    const props = bash.inputSchema.properties as Record<string, { description: string }>;
    expect(Object.keys(props)).toEqual(['command', 'timeout', 'background_after']);
    expect(props['background_after'].description).toContain('42');
    expect(bash.description).toContain('42');
  });

  it('defaults to ten minutes when no default is configured', () => {
    const bash = createBashTool(new AlmostBashShell({ fs }), fs, '/tmp');
    const props = bash.inputSchema.properties as Record<string, { description: string }>;
    expect(props['background_after'].description).toContain(
      String(DEFAULT_BASH_BACKGROUND_AFTER_SECONDS)
    );
  });

  it('detaches a command that outlives background_after and reports the job', async () => {
    const { shell } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp');

    const result = await bash.execute({ command: 'sleep 999', background_after: 0 });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('detached as background job bg-1');
    expect(result.content).toContain('/tmp/bash-bg-1.txt');
    expect(result.content).toContain('NOT blocked');
  });

  it('fires a bash lick with the exit code, preview, and output file when the job finishes', async () => {
    const { shell, settle } = pendingShell();
    const fireLick = vi.fn();
    const bash = createBashTool(shell, fs, '/tmp', { fireLick, targetScoop: 'andy-scoop' });

    await bash.execute({ command: 'slow-build', background_after: 0 });
    settle({ stdout: 'built ok\n', stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));

    const event = fireLick.mock.calls[0][0];
    expect(event.type).toBe('bash');
    expect(event.bashJobId).toBe('bg-1');
    expect(event.bashCommand).toBe('slow-build');
    expect(event.bashExitCode).toBe(0);
    expect(event.resultPath).toBe('/tmp/bash-bg-1.txt');
    expect(event.preview).toContain('built ok');
    // Routed back to the scoop that started the run, not to the cone.
    expect(event.targetScoop).toBe('andy-scoop');
    expect(await fs.readFile('/tmp/bash-bg-1.txt', { encoding: 'utf-8' })).toContain('built ok');
  });

  it('keeps base64 out of a background job lick preview (#2217)', async () => {
    const { shell, settle } = pendingShell();
    const fireLick = vi.fn();
    const bash = createBashTool(shell, fs, '/tmp', { fireLick });
    const marker = `<img:data:image/png;base64,${'A'.repeat(8 * 1024)}>`;

    await bash.execute({ command: 'open --view --size small shot.png', background_after: 0 });
    settle({
      stdout: `shot.png (768x768, 78 KB, image/png)\n${marker}\n`,
      stderr: '',
      exitCode: 0,
    });
    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));

    const event = fireLick.mock.calls[0][0];
    // The 2KB preview can't carry a picture, so it carries the line that matters.
    expect(event.preview).toContain('shot.png (768x768, 78 KB, image/png)');
    expect(event.preview).toContain('[image]');
    expect(event.preview).not.toContain('AAAA');
    // The marker survives in the persisted file, so `cat` still shows the image.
    expect(await fs.readFile('/tmp/bash-bg-1.txt', { encoding: 'utf-8' })).toContain(marker);
  });

  it('leaves targetScoop unset for the cone (untargeted licks route to the cone)', async () => {
    const { shell, settle } = pendingShell();
    const fireLick = vi.fn();
    const bash = createBashTool(shell, fs, '/tmp', { fireLick });

    await bash.execute({ command: 'x', background_after: 0 });
    settle({ stdout: 'done', stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));

    expect(fireLick.mock.calls[0][0].targetScoop).toBeUndefined();
  });

  it('reports a failed detached job with its exit code, and a thrown one as a shell error', async () => {
    const failing = pendingShell();
    const fireLick = vi.fn();
    const bash = createBashTool(failing.shell, fs, '/tmp', { fireLick });
    await bash.execute({ command: 'boom', background_after: 0 });
    failing.settle({ stdout: '', stderr: 'nope\n', exitCode: 3 });
    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));
    expect(fireLick.mock.calls[0][0].bashExitCode).toBe(3);
    expect(fireLick.mock.calls[0][0].preview).toContain('nope');

    const throwing = pendingShell();
    const fireLick2 = vi.fn();
    const bash2 = createBashTool(throwing.shell, fs, '/tmp', { fireLick: fireLick2 });
    await bash2.execute({ command: 'crash', background_after: 0 });
    throwing.fail(new Error('shell exploded'));
    await vi.waitFor(() => expect(fireLick2).toHaveBeenCalledTimes(1));
    expect(fireLick2.mock.calls[0][0].bashExitCode).toBe(1);
    expect(fireLick2.mock.calls[0][0].preview).toContain('shell exploded');
  });

  it('still persists a detached job output file when no lick sink is wired', async () => {
    const { shell, settle } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp');

    await bash.execute({ command: 'x', background_after: 0 });
    settle({ stdout: 'orphan output', stderr: '', exitCode: 0 });

    await vi.waitFor(async () =>
      expect(await fs.readFile('/tmp/bash-bg-1.txt', { encoding: 'utf-8' })).toContain(
        'orphan output'
      )
    );
  });

  it('numbers detached jobs per tool instance', async () => {
    const first = pendingShell();
    const bash = createBashTool(first.shell, fs, '/tmp');
    const a = await bash.execute({ command: 'a', background_after: 0 });
    const b = await bash.execute({ command: 'b', background_after: 0 });
    expect(a.content).toContain('bg-1');
    expect(b.content).toContain('bg-2');
  });

  it('kills the command at timeout instead of detaching when timeout <= background_after', async () => {
    const { shell, signals } = pendingShell();
    const fireLick = vi.fn();
    const bash = createBashTool(shell, fs, '/tmp', { fireLick });

    const result = await bash.execute({ command: 'hang', timeout: 0, background_after: 5 });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out after 0s');
    expect(signals[0]?.aborted).toBe(true);
    expect(fireLick).not.toHaveBeenCalled();
  });

  it('detaches first, then still enforces a larger timeout on the detached job', async () => {
    const { shell, signals } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp');

    const result = await bash.execute({ command: 'hang', timeout: 0.05, background_after: 0 });

    expect(result.content).toContain('detached as background job');
    expect(result.content).toContain('0.05s timeout');
    expect(signals[0]?.aborted).toBe(false);
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
  });

  it('honors the configured default and lets a per-call argument override it', async () => {
    const configured = pendingShell();
    const bash = createBashTool(configured.shell, fs, '/tmp', {
      defaultBackgroundAfterSeconds: 0,
    });
    const detached = await bash.execute({ command: 'x' });
    expect(detached.content).toContain('detached as background job');

    // A per-call budget the command finishes inside of keeps the result inline.
    const quick = createBashTool(new AlmostBashShell({ fs }), fs, '/tmp', {
      defaultBackgroundAfterSeconds: 0,
    });
    const inline = await quick.execute({ command: 'echo hi', background_after: 30 });
    expect(inline.content).toContain('hi');
    expect(inline.content).not.toContain('detached');
  });

  it('ignores a negative or non-numeric background_after and falls back to the default', async () => {
    const bash = createBashTool(new AlmostBashShell({ fs }), fs, '/tmp', {
      defaultBackgroundAfterSeconds: 30,
    });
    const result = await bash.execute({ command: 'echo hi', background_after: -5 });
    expect(result.content).toContain('hi');
  });

  // A detached job's output never crosses the `adaptTools` tool-result boundary
  // that scrubs a normal bash result, so the tool applies the scrub itself —
  // otherwise a configured secret printed by a background command would reach
  // agent history, the UI, and the transcript in the clear.
  it('scrubs a detached job output in BOTH the lick preview and the persisted file', async () => {
    const { shell, settle } = pendingShell();
    const fireLick = vi.fn();
    const scrubOutput = vi.fn(async (text: string) => text.replaceAll('sk-live-secret', '***'));
    const bash = createBashTool(shell, fs, '/tmp', { fireLick, scrubOutput });

    await bash.execute({ command: 'printenv TOKEN', background_after: 0 });
    settle({ stdout: 'TOKEN=sk-live-secret\n', stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));

    expect(scrubOutput).toHaveBeenCalledWith('TOKEN=sk-live-secret\n');
    expect(fireLick.mock.calls[0][0].preview).toBe('TOKEN=***\n');
    // The file is what the agent is told to `cat`, so it must be masked too.
    expect(await fs.readFile('/tmp/bash-bg-1.txt', { encoding: 'utf-8' })).toBe('TOKEN=***\n');
  });

  it('withholds the output rather than leaking it when the scrubber throws', async () => {
    const { shell, settle } = pendingShell();
    const fireLick = vi.fn();
    const bash = createBashTool(shell, fs, '/tmp', {
      fireLick,
      scrubOutput: async () => {
        throw new Error('pipeline down');
      },
    });

    await bash.execute({ command: 'printenv', background_after: 0 });
    settle({ stdout: 'TOKEN=sk-live-secret\n', stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));

    const event = fireLick.mock.calls[0][0];
    expect(event.preview).not.toContain('sk-live-secret');
    expect(event.preview).toContain('secret scrub unavailable');
    // Still delivered: the agent learns the job finished, and with which code.
    expect(event.bashExitCode).toBe(0);
    expect(await fs.readFile('/tmp/bash-bg-1.txt', { encoding: 'utf-8' })).not.toContain(
      'sk-live-secret'
    );
  });

  it('does not abort a detached job when the turn signal aborts afterwards', async () => {
    const { shell, signals } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp');
    const controller = new AbortController();

    await bash.execute({ command: 'long', background_after: 0 }, controller.signal);
    controller.abort();

    expect(signals[0]?.aborted).toBe(false);
  });
});

describe('Bash Tool job process (ps / kill reachability)', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-bash-job-${dbCounter++}`, wipe: true });
  });

  it('registers one job per invocation and threads its pid into the shell', async () => {
    const { host, jobs } = fakeJobHost();
    const shell = new AlmostBashShell({ fs });
    const spy = vi.spyOn(shell, 'executeCommand');
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: host });

    await bash.execute({ command: 'echo hi' });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].command).toBe('echo hi');
    // Third argument = the job pid, so realm-backed children parent to the job.
    expect(spy.mock.calls[0][2]).toBe(jobs[0].pid);
  });

  it('reaps the job with the command exit code when it completes normally', async () => {
    const { host, jobs } = fakeJobHost();
    const bash = createBashTool(new AlmostBashShell({ fs }), fs, '/tmp', { jobHost: host });

    await bash.execute({ command: 'exit 3' });

    expect(jobs[0].exits).toEqual([3]);
    expect(jobs[0].killed).toBe(0);
  });

  it('records the interrupted exit code when the TURN is cancelled (job never signalled)', async () => {
    const { host, jobs } = fakeJobHost();
    const { shell, fail } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: host });
    const turn = new AbortController();

    const pending = bash.execute({ command: 'long', background_after: 30 }, turn.signal);
    turn.abort();
    fail(new Error('aborted'));
    await pending;

    // Not `null`: nothing signalled the job pid, so the manager must not derive
    // a clean exit for a command that was interrupted.
    expect(jobs[0].exits).toEqual([1]);
    expect(jobs[0].killed).toBe(0);
  });

  it('SIGKILLs the job at timeout so realm descendants die with it', async () => {
    const { host, jobs } = fakeJobHost();
    const { shell, signals } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: host });

    const result = await bash.execute({ command: 'node -e "while(true){}"', timeout: 0 });

    expect(result.isError).toBe(true);
    expect(jobs[0].killed).toBe(1);
    // `null` lets the process manager derive the signal exit code (137).
    expect(jobs[0].exits).toEqual([null]);
    // The cooperative abort is still raised for the in-worker just-bash path.
    expect(signals[0]?.aborted).toBe(true);
  });

  it('keeps a detached job running (ps-visible) and names its pid for the model', async () => {
    const { host, jobs } = fakeJobHost();
    const { shell, settle } = pendingShell();
    const fireLick = vi.fn();
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: host, fireLick });

    const result = await bash.execute({ command: 'long-build', background_after: 0 });

    // Still live: nothing reaped the record while the command runs.
    expect(jobs[0].exits).toEqual([]);
    expect(result.content).toContain(`Pid ${jobs[0].pid}`);
    expect(result.content).toContain(`kill ${jobs[0].pid}`);

    settle({ stdout: 'done', stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));
    expect(jobs[0].exits).toEqual([0]);
    expect(fireLick.mock.calls[0][0].bashJobPid).toBe(jobs[0].pid);
  });

  it('aborts a detached run when its pid is killed from outside (kill <pid>)', async () => {
    const { host, jobs } = fakeJobHost();
    const { shell, signals, fail } = pendingShell();
    const fireLick = vi.fn();
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: host, fireLick });

    await bash.execute({ command: 'long-build', background_after: 0 });
    // What `kill <pid>` does: the manager aborts the job record's controller.
    jobs[0].controller.abort();
    expect(signals[0]?.aborted).toBe(true);

    // The shell surfaces the abort; the job still reports back rather than
    // vanishing silently.
    fail(new Error('aborted'));
    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));
    expect(fireLick.mock.calls[0][0].bashExitCode).toBe(1);
  });

  it('hard-kills a detached job when its larger timeout runs out', async () => {
    const { host, jobs } = fakeJobHost();
    const { shell } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp', { jobHost: host });

    await bash.execute({ command: 'hang', timeout: 0.05, background_after: 0 });

    expect(jobs[0].killed).toBe(0);
    await vi.waitFor(() => expect(jobs[0].killed).toBe(1));
  });

  it('runs unregistered (and without a pid note) when no job host is wired', async () => {
    const { shell } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp');

    const result = await bash.execute({ command: 'x', background_after: 0 });

    expect(result.content).toContain('detached as background job bg-1');
    expect(result.content).not.toContain('Pid ');
  });
});
