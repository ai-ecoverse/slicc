/**
 * Tests for AlmostBashShell utility functions.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../src/cdp/index.js';
import { FsWatcher, VirtualFS } from '../../src/fs/index.js';
import { WORKFLOW_MANAGER_GLOBAL_KEY } from '../../src/scoops/workflow-run-manager.js';
import {
  AlmostBashShell,
  decodeForbiddenResponseHeaders,
  encodeForbiddenRequestHeaders,
  isTextContentType,
} from '../../src/shell/almost-bash-shell.js';

describe('isTextContentType', () => {
  it('identifies text/* as text', () => {
    expect(isTextContentType('text/html')).toBe(true);
    expect(isTextContentType('text/plain')).toBe(true);
    expect(isTextContentType('text/css')).toBe(true);
    expect(isTextContentType('text/xml')).toBe(true);
  });

  it('identifies JSON as text', () => {
    expect(isTextContentType('application/json')).toBe(true);
    expect(isTextContentType('application/json; charset=utf-8')).toBe(true);
  });

  it('identifies XML as text', () => {
    expect(isTextContentType('application/xml')).toBe(true);
    expect(isTextContentType('application/xhtml+xml')).toBe(true);
  });

  it('identifies JavaScript as text', () => {
    expect(isTextContentType('application/javascript')).toBe(true);
    expect(isTextContentType('text/javascript')).toBe(true);
    expect(isTextContentType('application/ecmascript')).toBe(true);
  });

  it('identifies HTML as text', () => {
    expect(isTextContentType('text/html')).toBe(true);
    expect(isTextContentType('text/html; charset=utf-8')).toBe(true);
  });

  it('identifies CSS as text', () => {
    expect(isTextContentType('text/css')).toBe(true);
  });

  it('identifies SVG as text', () => {
    expect(isTextContentType('image/svg+xml')).toBe(true);
  });

  it('identifies image types as binary', () => {
    expect(isTextContentType('image/jpeg')).toBe(false);
    expect(isTextContentType('image/png')).toBe(false);
    expect(isTextContentType('image/gif')).toBe(false);
    expect(isTextContentType('image/webp')).toBe(false);
  });

  it('identifies archive types as binary', () => {
    expect(isTextContentType('application/zip')).toBe(false);
    expect(isTextContentType('application/gzip')).toBe(false);
    expect(isTextContentType('application/octet-stream')).toBe(false);
  });

  it('identifies PDF as binary', () => {
    expect(isTextContentType('application/pdf')).toBe(false);
  });

  it('identifies audio/video as binary', () => {
    expect(isTextContentType('audio/mpeg')).toBe(false);
    expect(isTextContentType('video/mp4')).toBe(false);
  });

  it('treats empty content-type as text (safe default)', () => {
    expect(isTextContentType('')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isTextContentType('Application/JSON')).toBe(true);
    expect(isTextContentType('IMAGE/JPEG')).toBe(false);
    expect(isTextContentType('Text/HTML')).toBe(true);
  });
});

describe('encodeForbiddenRequestHeaders', () => {
  it('returns empty object for undefined input', () => {
    expect(encodeForbiddenRequestHeaders(undefined)).toEqual({});
  });

  it('returns empty object for empty object input', () => {
    expect(encodeForbiddenRequestHeaders({})).toEqual({});
  });

  it('passes through normal headers unchanged', () => {
    const headers = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };
    expect(encodeForbiddenRequestHeaders(headers)).toEqual(headers);
  });

  it('encodes Cookie → X-Proxy-Cookie', () => {
    expect(encodeForbiddenRequestHeaders({ Cookie: 'sid=abc' })).toEqual({
      'X-Proxy-Cookie': 'sid=abc',
    });
  });

  it('encodes cookie (lowercase) → X-Proxy-Cookie', () => {
    expect(encodeForbiddenRequestHeaders({ cookie: 'sid=abc' })).toEqual({
      'X-Proxy-Cookie': 'sid=abc',
    });
  });

  it('encodes Origin → X-Proxy-Origin', () => {
    expect(encodeForbiddenRequestHeaders({ Origin: 'https://suno.com' })).toEqual({
      'X-Proxy-Origin': 'https://suno.com',
    });
  });

  it('encodes origin (lowercase) → X-Proxy-Origin', () => {
    expect(encodeForbiddenRequestHeaders({ origin: 'https://suno.com' })).toEqual({
      'X-Proxy-Origin': 'https://suno.com',
    });
  });

  it('encodes Referer → X-Proxy-Referer', () => {
    expect(encodeForbiddenRequestHeaders({ Referer: 'https://example.com/page' })).toEqual({
      'X-Proxy-Referer': 'https://example.com/page',
    });
  });

  it('encodes Proxy-Authorization → X-Proxy-Proxy-Authorization', () => {
    expect(encodeForbiddenRequestHeaders({ 'Proxy-Authorization': 'Basic abc' })).toEqual({
      'X-Proxy-Proxy-Authorization': 'Basic abc',
    });
  });

  it('encodes proxy-authorization (lowercase) → X-Proxy-proxy-authorization', () => {
    expect(encodeForbiddenRequestHeaders({ 'proxy-authorization': 'Basic abc' })).toEqual({
      'X-Proxy-proxy-authorization': 'Basic abc',
    });
  });

  it('handles mixed headers (some normal, some forbidden)', () => {
    const result = encodeForbiddenRequestHeaders({
      Accept: 'text/html',
      Cookie: 'sid=abc',
      Origin: 'https://example.com',
      Referer: 'https://example.com/page',
      'Proxy-Authorization': 'Basic xyz',
      'Content-Type': 'application/json',
    });
    expect(result).toEqual({
      Accept: 'text/html',
      'X-Proxy-Cookie': 'sid=abc',
      'X-Proxy-Origin': 'https://example.com',
      'X-Proxy-Referer': 'https://example.com/page',
      'X-Proxy-Proxy-Authorization': 'Basic xyz',
      'Content-Type': 'application/json',
    });
  });
});

describe('decodeForbiddenResponseHeaders', () => {
  it('passes through normal headers unchanged', () => {
    const headers = { 'content-type': 'text/html', 'x-request-id': '123' };
    expect(decodeForbiddenResponseHeaders(headers)).toEqual(headers);
  });

  it('decodes X-Proxy-Set-Cookie → set-cookie', () => {
    const headers = { 'X-Proxy-Set-Cookie': '["sid=abc; Path=/"]' };
    expect(decodeForbiddenResponseHeaders(headers)).toEqual({
      'set-cookie': '["sid=abc; Path=/"]',
    });
  });

  it('decodes x-proxy-set-cookie (lowercase) → set-cookie', () => {
    const headers = { 'x-proxy-set-cookie': '["sid=abc"]' };
    expect(decodeForbiddenResponseHeaders(headers)).toEqual({
      'set-cookie': '["sid=abc"]',
    });
  });

  it('preserves JSON array string value when decoding Set-Cookie', () => {
    const jsonArray = '["sid=abc; Path=/", "theme=dark; HttpOnly"]';
    const result = decodeForbiddenResponseHeaders({
      'X-Proxy-Set-Cookie': jsonArray,
    });
    expect(result['set-cookie']).toBe(jsonArray);
  });

  it('handles empty object input', () => {
    expect(decodeForbiddenResponseHeaders({})).toEqual({});
  });

  it('handles headers with no transport headers (passthrough)', () => {
    const headers = { 'cache-control': 'no-cache', etag: '"v1"' };
    expect(decodeForbiddenResponseHeaders(headers)).toEqual(headers);
  });

  it('handles mixed headers (transport + normal)', () => {
    const result = decodeForbiddenResponseHeaders({
      'content-type': 'text/html',
      'X-Proxy-Set-Cookie': '["sid=abc"]',
      'x-request-id': '42',
    });
    expect(result).toEqual({
      'content-type': 'text/html',
      'set-cookie': '["sid=abc"]',
      'x-request-id': '42',
    });
  });
});

describe('AlmostBashShell playwright command discoverability', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-almost-bash-shell-${dbCounter++}`,
      wipe: true,
    });
  });

  it('exposes playwright aliases and host through which, commands, and /usr/bin when browserAPI is provided', async () => {
    const shell = new AlmostBashShell({
      fs,
      browserAPI: {} as BrowserAPI,
    });

    const whichResult = await shell.executeCommand(
      'which playwright-cli playwright puppeteer host'
    );
    expect(whichResult.exitCode).toBe(0);
    expect(whichResult.stdout).toContain('/usr/bin/playwright-cli');
    expect(whichResult.stdout).toContain('/usr/bin/playwright');
    expect(whichResult.stdout).toContain('/usr/bin/puppeteer');
    expect(whichResult.stdout).toContain('/usr/bin/host');

    const commandsResult = await shell.executeCommand('commands | grep playwright');
    expect(commandsResult.exitCode).toBe(0);
    expect(commandsResult.stdout).toContain('playwright');
    expect(commandsResult.stdout).toContain('playwright-cli');

    const hostCommandsResult = await shell.executeCommand('commands | grep host');
    expect(hostCommandsResult.exitCode).toBe(0);
    expect(hostCommandsResult.stdout).toContain('host');

    const usrBinResult = await shell.executeCommand('ls /usr/bin | grep playwright');
    expect(usrBinResult.exitCode).toBe(0);
    expect(usrBinResult.stdout).toContain('playwright');
    expect(usrBinResult.stdout).toContain('playwright-cli');
  });

  it('keeps playwright aliases and host discoverable even without browserAPI', async () => {
    const shell = new AlmostBashShell({ fs });

    const whichResult = await shell.executeCommand('which playwright-cli host');
    expect(whichResult.exitCode).toBe(0);
    expect(whichResult.stdout).toContain('/usr/bin/playwright-cli');
    expect(whichResult.stdout).toContain('/usr/bin/host');

    const commandsResult = await shell.executeCommand('commands | grep playwright');
    expect(commandsResult.exitCode).toBe(0);
    expect(commandsResult.stdout).toContain('playwright-cli');
    expect(commandsResult.stdout).toContain('puppeteer');

    const hostCommandsResult = await shell.executeCommand('commands | grep host');
    expect(hostCommandsResult.exitCode).toBe(0);
    expect(hostCommandsResult.stdout).toContain('host');

    const usrBinResult = await shell.executeCommand('ls /usr/bin | grep playwright');
    expect(usrBinResult.exitCode).toBe(0);
    expect(usrBinResult.stdout).toContain('playwright');
    expect(usrBinResult.stdout).toContain('playwright-cli');

    const openResult = await shell.executeCommand('playwright-cli open https://example.com');
    expect(openResult.exitCode).toBe(1);
    expect(openResult.stderr).toContain('browser APIs are unavailable');
  });
  it('accepts an external AbortSignal when executing commands programmatically', async () => {
    const shell = new AlmostBashShell({ fs });
    const controller = new AbortController();
    const execSpy = vi.spyOn((shell as any).bash, 'exec');

    const result = await shell.executeCommand('pwd', controller.signal);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/');
    expect(execSpy).toHaveBeenCalledWith(
      'pwd',
      expect.objectContaining({
        signal: controller.signal,
      })
    );
  });

  it('shares BSH discovery through the shell-owned script catalog', async () => {
    fs.setWatcher(new FsWatcher());
    await fs.writeFile('/workspace/login.example.com.bsh', 'console.log("login");');

    const shell = new AlmostBashShell({ fs });

    expect((await shell.getScriptCatalog().getBshEntries()).map((entry) => entry.path)).toEqual([
      '/workspace/login.example.com.bsh',
    ]);
  });
});

let jshRegistrationDbCounter = 0;

describe('AlmostBashShell .jsh command registration', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-jsh-reg-${jshRegistrationDbCounter++}`,
      wipe: true,
    });
    await fs.mkdir('/workspace/skills/test-cmd/scripts', { recursive: true });
  });

  afterEach(async () => {
    await fs.dispose();
  });

  it('registers .jsh commands as first-class bash commands available in pipelines', async () => {
    // Create a .jsh script that outputs text
    await fs.writeFile(
      '/workspace/skills/test-cmd/scripts/hello.jsh',
      'console.log("hello from jsh");'
    );

    const shell = new AlmostBashShell({ fs });
    // Wait for async syncJshCommands to complete
    await shell.syncJshCommands();

    // Direct invocation should work
    const direct = await shell.executeCommand('hello');
    expect(direct.exitCode).toBe(0);
    expect(direct.stdout).toContain('hello from jsh');

    // Pipeline should also work (this was the bug — before registration,
    // jsh commands in pipes would fail because exit code 127 from the pipe
    // component doesn't propagate to the top-level runCommand fallback)
    const piped = await shell.executeCommand('hello | cat');
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout).toContain('hello from jsh');
  });

  it('makes .jsh commands visible via which and /usr/bin', async () => {
    await fs.writeFile('/workspace/skills/test-cmd/scripts/mycmd.jsh', 'console.log("ok");');

    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();

    const whichResult = await shell.executeCommand('which mycmd');
    expect(whichResult.exitCode).toBe(0);

    const lsResult = await shell.executeCommand('ls /usr/bin | grep mycmd');
    expect(lsResult.exitCode).toBe(0);
    expect(lsResult.stdout).toContain('mycmd');
  });

  it('passes arguments to registered .jsh commands', async () => {
    await fs.writeFile(
      '/workspace/skills/test-cmd/scripts/greet.jsh',
      'console.log("hello " + process.argv.slice(2).join(" "));'
    );

    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();

    const result = await shell.executeCommand('greet world');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello world');
  });

  it('threads piped stdin into registered .jsh commands', async () => {
    // The agent-facing path: a `.jsh` script registered as a bash command
    // must be able to read piped input. Before stdin-in-jsh support, the
    // script would see an empty string regardless of the upstream pipe.
    await fs.writeFile(
      '/workspace/skills/test-cmd/scripts/upper.jsh',
      'process.stdout.write(process.stdin.read().toUpperCase());'
    );

    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();

    const piped = await shell.executeCommand('echo -n hello | upper');
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout).toBe('HELLO');
  });

  it('exposes process.stdin.read() inside registered .jsh commands', async () => {
    await fs.writeFile(
      '/workspace/skills/test-cmd/scripts/wc-bytes.jsh',
      'console.log(process.stdin.read().length);'
    );

    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();

    const piped = await shell.executeCommand('echo -n abcdef | wc-bytes');
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout.trim()).toBe('6');
  });

  it('does not shadow built-in commands with .jsh files of the same name', async () => {
    // Create a .jsh file named "echo" — should NOT override the built-in
    await fs.writeFile('/workspace/skills/test-cmd/scripts/echo.jsh', 'console.log("fake echo");');

    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();

    const result = await shell.executeCommand('echo real');
    expect(result.stdout).toContain('real');
    expect(result.stdout).not.toContain('fake echo');
  });
});

let allowlistDbCounter = 0;

describe('AlmostBashShell command allow-list', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-allowlist-${allowlistDbCounter++}`,
      wipe: true,
    });
  });

  afterEach(async () => {
    await fs.dispose();
  });

  it('registers all commands when allowedCommands is omitted (default)', async () => {
    const shell = new AlmostBashShell({ fs });

    expect((await shell.executeCommand('echo hi')).exitCode).toBe(0);
    expect((await shell.executeCommand('pwd')).exitCode).toBe(0);
    expect((await shell.executeCommand('ls /')).exitCode).toBe(0);
  });

  it('registers all commands when allowedCommands is the wildcard ["*"]', async () => {
    const shell = new AlmostBashShell({ fs, allowedCommands: ['*'] });

    expect((await shell.executeCommand('echo hi')).exitCode).toBe(0);
    expect((await shell.executeCommand('ls /')).exitCode).toBe(0);
  });

  it('blocks every command when allowedCommands is empty', async () => {
    const shell = new AlmostBashShell({ fs, allowedCommands: [] });

    const result = await shell.executeCommand('echo hi');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/command not found|not found/i);
  });

  it('allows listed commands and rejects unlisted ones with exit 127', async () => {
    const shell = new AlmostBashShell({ fs, allowedCommands: ['echo'] });

    const ok = await shell.executeCommand('echo hello');
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('hello');

    const blocked = await shell.executeCommand('ls /');
    expect(blocked.exitCode).toBe(127);
    expect(blocked.stderr).toMatch(/ls/);
    expect(blocked.stderr).toMatch(/not found/i);
  });

  it('blocks disallowed commands inside a pipeline', async () => {
    const shell = new AlmostBashShell({ fs, allowedCommands: ['echo'] });

    // `echo` is allowed but `cat` is not — the pipeline should fail at `cat`.
    const piped = await shell.executeCommand('echo hi | cat');
    expect(piped.exitCode).not.toBe(0);
    expect(piped.stderr).toMatch(/cat/);
    expect(piped.stderr).toMatch(/not found/i);
  });

  it('blocks disallowed commands inside command substitution', async () => {
    const shell = new AlmostBashShell({ fs, allowedCommands: ['echo'] });

    // The substitution `$(ls /)` invokes `ls`, which must be blocked. Bash
    // continues and runs `echo` with an empty substitution, but stderr
    // carries the substitution failure.
    const result = await shell.executeCommand('echo "before:$(ls /):after"');
    expect(result.stderr).toMatch(/ls/);
    expect(result.stderr).toMatch(/not found/i);
    expect(result.stdout).toContain('before::after');
  });

  it('filters custom (supplemental) commands the same way as built-ins', async () => {
    // Use a custom command — `mount` is created by MountCommands. Omitting it
    // from the allow-list should block it; including it should keep it working.
    const blockedShell = new AlmostBashShell({ fs, allowedCommands: ['echo'] });
    const blocked = await blockedShell.executeCommand('mount');
    expect(blocked.exitCode).toBe(127);
    expect(blocked.stderr).toMatch(/mount/);
    expect(blocked.stderr).toMatch(/not found/i);

    // When `mount` is allow-listed the custom command is dispatched — even if
    // it returns non-zero for missing args, the stderr must not say
    // "command not found" (that would mean the allow-list blocked it).
    const allowedShell = new AlmostBashShell({ fs, allowedCommands: ['mount'] });
    const allowed = await allowedShell.executeCommand('mount');
    expect(allowed.stderr).not.toMatch(/not found/i);
  });

  it('filters .jsh commands the same way as built-ins', async () => {
    await fs.mkdir('/workspace/skills/allowlist-jsh/scripts', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/allowlist-jsh/scripts/greet.jsh',
      'console.log("hello from greet");'
    );

    // With `greet` blocked, the shell should not dispatch to the .jsh file.
    const blocked = new AlmostBashShell({ fs, allowedCommands: ['echo'] });
    await blocked.syncJshCommands();
    const blockedResult = await blocked.executeCommand('greet');
    expect(blockedResult.exitCode).toBe(127);
    expect(blockedResult.stderr).toMatch(/not found/i);

    // With `greet` listed, the .jsh file is registered and runs normally.
    const allowed = new AlmostBashShell({ fs, allowedCommands: ['greet'] });
    await allowed.syncJshCommands();
    const allowedResult = await allowed.executeCommand('greet');
    expect(allowedResult.exitCode).toBe(0);
    expect(allowedResult.stdout).toContain('hello from greet');
  });

  it('omits blocked commands from the /usr/bin virtual directory', async () => {
    const shell = new AlmostBashShell({ fs, allowedCommands: ['echo', 'ls'] });

    const listing = await shell.executeCommand('ls /usr/bin');
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toContain('echo');
    expect(listing.stdout).toContain('ls');
    // `cat` exists in just-bash but was not allowed — it must not appear.
    expect(listing.stdout.split(/\s+/).filter((w) => w === 'cat')).toHaveLength(0);
  });

  it('blocks network commands (curl, wget) that just-bash auto-registers when fetch is set', async () => {
    // just-bash's constructor unconditionally registers every network command
    // when `fetch` or `network` is provided, regardless of `BashOptions.commands`.
    // `AlmostBashShell` always provides `fetch`, so without post-construction cleanup
    // a scoop with `allowedCommands: ['echo']` could still run `curl`. This
    // test guards the cleanup in `AlmostBashShell`'s constructor. See Codex review
    // of #433.
    const shell = new AlmostBashShell({ fs, allowedCommands: ['echo'] });

    const curl = await shell.executeCommand('curl http://example.com');
    expect(curl.exitCode).toBe(127);
    expect(curl.stderr).toMatch(/curl/);
    expect(curl.stderr).toMatch(/not found/i);

    const wget = await shell.executeCommand('wget http://example.com');
    expect(wget.exitCode).toBe(127);
    expect(wget.stderr).toMatch(/wget/);
    expect(wget.stderr).toMatch(/not found/i);
  });

  it('keeps network commands available when they are on the allow-list', async () => {
    // Inverse of the above — when a network command IS allowed, the cleanup
    // must not remove it. We don't try to actually fetch (would need a real
    // network); it's enough that the command name is recognized at dispatch.
    const shell = new AlmostBashShell({ fs, allowedCommands: ['curl'] });

    const result = await shell.executeCommand('curl');
    // curl with no args exits with usage error (2) — NOT 127. If cleanup
    // accidentally removed it, we'd see 127 / "command not found" instead.
    expect(result.exitCode).not.toBe(127);
    expect(result.stderr).not.toMatch(/not found/i);
  });
});

function installFakeWfManager(): void {
  (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY] = {
    start: async () => ({ runId: 'r1' }),
    getRun: () => null,
    listRuns: () => [],
    observeRun: () => () => {},
  };
}

describe('AlmostBashShell workflow command registration', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-wf-reg-${Math.random()}`, wipe: true });
  });
  afterEach(async () => {
    delete (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY];
    await fs.dispose();
  });

  it('registers a saved workflow as a bare command that runs non-blocking', async () => {
    installFakeWfManager();
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile(
      '/workspace/.workflows/audit.workflow.js',
      "export const meta = { name: 'audit' };\nreturn 1"
    );
    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('audit');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/started/i);
  });

  it('a skill workflow is reachable as <skill>:<name>', async () => {
    installFakeWfManager();
    await fs.mkdir('/workspace/skills/triage/.workflows', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/triage/.workflows/sweep.workflow.js',
      "export const meta = { name: 'sweep' };\nreturn 1"
    );
    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('triage:sweep');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/started/i);
  });

  it('a .jsh wins the bare name over a saved workflow (precedence at dispatch)', async () => {
    installFakeWfManager();
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile(
      '/workspace/.workflows/foo.workflow.js',
      "export const meta={name:'foo'};\nreturn 1"
    );
    await fs.writeFile('/workspace/foo.jsh', "console.log('JSH-WON');");
    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('foo');
    expect(res.stdout).toContain('JSH-WON');
  });

  it('deleting the .jsh falls back to the workflow at dispatch (no re-register)', async () => {
    installFakeWfManager();
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile(
      '/workspace/.workflows/foo.workflow.js',
      "export const meta={name:'foo'};\nreturn 1"
    );
    await fs.writeFile('/workspace/foo.jsh', "console.log('JSH-WON');");
    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();
    await fs.rm('/workspace/foo.jsh');
    const res = await shell.executeCommand('foo');
    expect(res.stdout).toMatch(/started/i);
  });

  it('a .jsh added AFTER a workflow is registered wins at dispatch (reverse transition)', async () => {
    installFakeWfManager();
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile(
      '/workspace/.workflows/foo.workflow.js',
      "export const meta={name:'foo'};\nreturn 1"
    );
    const shell = new AlmostBashShell({ fs });
    await shell.syncJshCommands();
    const before = await shell.executeCommand('foo');
    expect(before.stdout).toMatch(/started/i); // workflow-only → runs the workflow
    // A .jsh of the same name appears later. The jsh sync skips re-registering (the name is
    // already a registered script command), but the single late-binding handler resolves
    // .jsh-first at dispatch — so the next invocation must run the .jsh.
    await fs.writeFile('/workspace/foo.jsh', "console.log('JSH-LATER');");
    await shell.syncJshCommands();
    const after = await shell.executeCommand('foo');
    expect(after.stdout).toContain('JSH-LATER');
  });
});

let vfsRoundTripDbCounter = 0;

/**
 * Real VFS round-trip: a realm script (`.jsh`) that writes through
 * `require('sliccy:exec')` shell commands AND through `require('fs')` must land
 * in the SAME `VirtualFS` the `bash` tool reads back. This disproves the
 * "separate invisible filesystem" claim — the realm's `exec`/`fs` RPC dispatch
 * back into the shell's live `VfsAdapter` → `VirtualFS`, so a subsequent
 * `shell.executeCommand('cat …')` (the bash-tool path) sees the writes, and a
 * direct `fs.readFile(…)` on the shared instance sees them too.
 */
describe('AlmostBashShell VFS round-trip', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-vfs-roundtrip-${vfsRoundTripDbCounter++}`,
      wipe: true,
    });
  });

  afterEach(async () => {
    await fs.dispose();
  });

  it("makes require('sliccy:exec') shell writes visible to the bash tool", async () => {
    await fs.writeFile(
      '/workspace/exec-writer.jsh',
      [
        "const { exec } = require('sliccy:exec');",
        "await exec('mkdir -p /workspace/rt');",
        "await exec('echo exec-payload > /workspace/rt/from-exec.txt');",
        "console.log('wrote via exec');",
      ].join('\n')
    );

    const shell = new AlmostBashShell({ fs });

    // Realm-side: the script's shell commands run successfully.
    const run = await shell.executeScriptFile('/workspace/exec-writer.jsh');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('wrote via exec');

    // Bash-tool-side: the SAME shell reads back what the realm wrote.
    const read = await shell.executeCommand('cat /workspace/rt/from-exec.txt');
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe('exec-payload');

    // And the write is visible on the shared VirtualFS instance directly.
    expect(((await fs.readFile('/workspace/rt/from-exec.txt')) as string).trim()).toBe(
      'exec-payload'
    );
  });

  it("makes require('fs').writeFile writes visible to the bash tool", async () => {
    await fs.writeFile(
      '/workspace/fs-writer.jsh',
      [
        "const fs = require('fs');",
        "await fs.mkdir('/workspace/rt');",
        "await fs.writeFile('/workspace/rt/from-fs.txt', 'fs-payload');",
        "console.log('wrote via fs');",
      ].join('\n')
    );

    const shell = new AlmostBashShell({ fs });

    // Realm-side: the fs bridge write succeeds.
    const run = await shell.executeScriptFile('/workspace/fs-writer.jsh');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('wrote via fs');

    // Bash-tool-side: `ls` + `cat` see the realm's write.
    const ls = await shell.executeCommand('ls /workspace/rt');
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toContain('from-fs.txt');

    const read = await shell.executeCommand('cat /workspace/rt/from-fs.txt');
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe('fs-payload');

    // And the write is visible on the shared VirtualFS instance directly.
    expect(await fs.readFile('/workspace/rt/from-fs.txt')).toBe('fs-payload');
  });

  it("makes require('fs').fetchToFile downloads visible to the bash tool", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    try {
      await fs.writeFile(
        '/workspace/fetcher.jsh',
        [
          "const fs = require('fs');",
          "await fs.mkdir('/workspace/rt');",
          "const n = await fs.fetchToFile('https://example.com/blob.bin', '/workspace/rt/from-fetch.bin');",
          "console.log('bytes:' + n);",
        ].join('\n')
      );

      const shell = new AlmostBashShell({ fs });

      // Realm-side: the fetch went through the host fetch and wrote the bytes.
      const run = await shell.executeScriptFile('/workspace/fetcher.jsh');
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('bytes:4');
      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/blob.bin');

      // Bash-tool-side: the downloaded file exists.
      const exists = await shell.executeCommand('test -f /workspace/rt/from-fetch.bin');
      expect(exists.exitCode).toBe(0);

      // And the exact bytes are visible on the shared VirtualFS instance.
      const bytes = (await fs.readFile('/workspace/rt/from-fetch.bin', {
        encoding: 'binary',
      })) as Uint8Array;
      expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

let coherenceDbCounter = 0;

/**
 * sliccy:exec ↔ synchronous fs cache coherence WITHIN a single script.
 *
 * The realm's `*Sync` fs APIs read/write an in-memory `SyncFsCache` snapshotted
 * once at boot; `exec` runs the host shell directly against the VFS. The exec
 * bridge bridges the two: it flushes pending sync mutations to the host BEFORE
 * an exec and re-snapshots the host AFTER, so a `writeFileSync` is visible to a
 * later `exec`, and an `exec`'s writes are visible to a later `readFileSync`.
 * All of this is gated on the sync-fs API actually being used (perf).
 */
describe('AlmostBashShell sync-fs ↔ exec coherence', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-coherence-${coherenceDbCounter++}`,
      wipe: true,
    });
  });

  afterEach(async () => {
    await fs.dispose();
  });

  // Test A: sync write → exec sees it (flush-before-exec).
  it('a writeFileSync is visible to a subsequent exec in the same script', async () => {
    await fs.writeFile(
      '/workspace/a.jsh',
      [
        "const fs = require('fs');",
        "const { exec } = require('sliccy:exec');",
        "fs.mkdirSync('/workspace/ca', { recursive: true });",
        "fs.writeFileSync('/workspace/ca/sync.txt', 'sync-payload');",
        "const r = await exec('cat /workspace/ca/sync.txt');",
        "console.log('EXEC:' + r.stdout.trim());",
      ].join('\n')
    );

    const shell = new AlmostBashShell({ fs });
    const run = await shell.executeScriptFile('/workspace/a.jsh');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('EXEC:sync-payload');
  });

  // Test B: exec → sync read sees it (re-snapshot-after-exec).
  it("an exec's write is visible to a subsequent readFileSync in the same script", async () => {
    await fs.writeFile(
      '/workspace/b.jsh',
      [
        "const fs = require('fs');",
        "const { exec } = require('sliccy:exec');",
        "fs.mkdirSync('/workspace/cb', { recursive: true });",
        "await exec('echo hi-from-exec > /workspace/cb/out.txt');",
        "const s = fs.readFileSync('/workspace/cb/out.txt', 'utf8');",
        "console.log('READ:' + s.trim());",
      ].join('\n')
    );

    const shell = new AlmostBashShell({ fs });
    const run = await shell.executeScriptFile('/workspace/b.jsh');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('READ:hi-from-exec');
  });

  // Test C: async write → exec sees it (already coherent via direct RPC; guard it).
  it('an async fs.writeFile is visible to a subsequent exec (existing coherent path)', async () => {
    await fs.writeFile(
      '/workspace/c.jsh',
      [
        "const fs = require('fs');",
        "const { exec } = require('sliccy:exec');",
        "await fs.mkdir('/workspace/cc');",
        "await fs.writeFile('/workspace/cc/async.txt', 'async-payload');",
        "const r = await exec('cat /workspace/cc/async.txt');",
        "console.log('EXEC:' + r.stdout.trim());",
      ].join('\n')
    );

    const shell = new AlmostBashShell({ fs });
    const run = await shell.executeScriptFile('/workspace/c.jsh');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('EXEC:async-payload');
  });

  // Test D: a sync write flushed mid-script by an exec, then a later sync
  // mutation, yields the correct FINAL VFS state — no stale re-apply. The exec
  // OVERWRITES the mid-flushed file on the host; if the end-of-script flush
  // re-applied the stale pre-exec content, `a.txt` would read back as the old
  // value instead of the exec's.
  it('does not re-apply already-flushed sync mutations at end-of-script', async () => {
    await fs.writeFile(
      '/workspace/d.jsh',
      [
        "const fs = require('fs');",
        "const { exec } = require('sliccy:exec');",
        "fs.mkdirSync('/workspace/cd', { recursive: true });",
        "fs.writeFileSync('/workspace/cd/a.txt', 'ORIGINAL');",
        "await exec('echo MODIFIED > /workspace/cd/a.txt');",
        "fs.writeFileSync('/workspace/cd/b.txt', 'BEE');",
      ].join('\n')
    );

    const shell = new AlmostBashShell({ fs });
    const run = await shell.executeScriptFile('/workspace/d.jsh');
    expect(run.exitCode).toBe(0);

    // FINAL state via the bash tool (separate command → post-script VFS):
    // a.txt keeps the exec's value (no stale re-apply), b.txt is the later write.
    const a = await shell.executeCommand('cat /workspace/cd/a.txt');
    expect(a.exitCode).toBe(0);
    expect(a.stdout.trim()).toBe('MODIFIED');

    const b = await shell.executeCommand('cat /workspace/cd/b.txt');
    expect(b.exitCode).toBe(0);
    expect(b.stdout.trim()).toBe('BEE');
  });

  // Test E (Bug 1): a sync write issued AFTER exec.start() but BEFORE
  // `await done` must survive the post-spawn re-snapshot and reach the host.
  // The killable spawn runs its flush/re-snapshot in a background IIFE while
  // user code keeps running, so `later.txt` lives only in the sync cache when
  // the spawn's re-snapshot fires. A plain applySnapshot would rebuild the
  // tree from the host and silently drop it; the mutation-preserving
  // re-snapshot must keep it so the end-of-script flush ships it.
  it('preserves a sync write made while an exec.start spawn is in flight', async () => {
    // Matches the documented Bug 1 flow: the FIRST sync-fs use is the write
    // issued AFTER start() but BEFORE `await done`, so it lives only in the
    // cache when the background spawn's re-snapshot fires.
    await fs.writeFile(
      '/workspace/e.jsh',
      [
        "const fs = require('fs');",
        "const { exec } = require('sliccy:exec');",
        "const h = exec.start('true');",
        'h.stdin.end();',
        "fs.writeFileSync('/workspace/later_e.txt', 'LATER');",
        'await h.done;',
      ].join('\n')
    );

    const shell = new AlmostBashShell({ fs });
    const run = await shell.executeScriptFile('/workspace/e.jsh');
    expect(run.exitCode).toBe(0);

    // FINAL state via the bash tool (separate command → post-script VFS):
    // the sync write survived to the host VFS.
    const later = await shell.executeCommand('cat /workspace/later_e.txt');
    expect(later.exitCode).toBe(0);
    expect(later.stdout.trim()).toBe('LATER');
  });

  // Test F (Bug 2): a kill() issued during the pre-registration flush window
  // (synchronously after stdin.end(), before the background flush resolves)
  // must keep the command client-side — the host never receives exec:start, so
  // the command never runs — and resolve `done` as terminated (128+SIGTERM).
  it('a kill() during the flush window prevents exec.start from ever running', async () => {
    await fs.writeFile(
      '/workspace/f.jsh',
      [
        "const fs = require('fs');",
        "const { exec } = require('sliccy:exec');",
        "await fs.mkdir('/workspace/cf', { recursive: true });",
        "const h = exec.start('echo RAN > /workspace/cf/out.txt');",
        'h.stdin.end();',
        "await h.kill('SIGTERM');",
        'const r = await h.done;',
        "console.log('EXIT:' + r.exitCode);",
      ].join('\n')
    );

    const shell = new AlmostBashShell({ fs });
    const run = await shell.executeScriptFile('/workspace/f.jsh');
    expect(run.exitCode).toBe(0);
    // `done` resolved as terminated by SIGTERM (128 + 15).
    expect(run.stdout).toContain('EXIT:143');

    // The command never dispatched, so it never created out.txt on the host.
    const ran = await shell.executeCommand('test -f /workspace/cf/out.txt');
    expect(ran.exitCode).not.toBe(0);
  });
});
