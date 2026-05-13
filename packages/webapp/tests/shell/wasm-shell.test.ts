/**
 * Tests for WasmShell utility functions.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../src/cdp/index.js';
import { FsWatcher, VirtualFS } from '../../src/fs/index.js';
import {
  decodeForbiddenResponseHeaders,
  encodeForbiddenRequestHeaders,
  isTextContentType,
  WasmShell,
} from '../../src/shell/wasm-shell.js';

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

describe('WasmShell playwright command discoverability', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-wasm-shell-${dbCounter++}`,
      wipe: true,
    });
  });

  it('exposes playwright aliases and host through which, commands, and /usr/bin when browserAPI is provided', async () => {
    const shell = new WasmShell({
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
    const shell = new WasmShell({ fs });

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
    const shell = new WasmShell({ fs });
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

    const shell = new WasmShell({ fs });

    expect((await shell.getScriptCatalog().getBshEntries()).map((entry) => entry.path)).toEqual([
      '/workspace/login.example.com.bsh',
    ]);
  });
});

let jshRegistrationDbCounter = 0;

describe('WasmShell .jsh command registration', () => {
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

    const shell = new WasmShell({ fs });
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

    const shell = new WasmShell({ fs });
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

    const shell = new WasmShell({ fs });
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
      'process.stdout.write(stdin.toUpperCase());'
    );

    const shell = new WasmShell({ fs });
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

    const shell = new WasmShell({ fs });
    await shell.syncJshCommands();

    const piped = await shell.executeCommand('echo -n abcdef | wc-bytes');
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout.trim()).toBe('6');
  });

  it('does not shadow built-in commands with .jsh files of the same name', async () => {
    // Create a .jsh file named "echo" — should NOT override the built-in
    await fs.writeFile('/workspace/skills/test-cmd/scripts/echo.jsh', 'console.log("fake echo");');

    const shell = new WasmShell({ fs });
    await shell.syncJshCommands();

    const result = await shell.executeCommand('echo real');
    expect(result.stdout).toContain('real');
    expect(result.stdout).not.toContain('fake echo');
  });
});

let allowlistDbCounter = 0;

describe('WasmShell command allow-list', () => {
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
    const shell = new WasmShell({ fs });

    expect((await shell.executeCommand('echo hi')).exitCode).toBe(0);
    expect((await shell.executeCommand('pwd')).exitCode).toBe(0);
    expect((await shell.executeCommand('ls /')).exitCode).toBe(0);
  });

  it('registers all commands when allowedCommands is the wildcard ["*"]', async () => {
    const shell = new WasmShell({ fs, allowedCommands: ['*'] });

    expect((await shell.executeCommand('echo hi')).exitCode).toBe(0);
    expect((await shell.executeCommand('ls /')).exitCode).toBe(0);
  });

  it('blocks every command when allowedCommands is empty', async () => {
    const shell = new WasmShell({ fs, allowedCommands: [] });

    const result = await shell.executeCommand('echo hi');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/command not found|not found/i);
  });

  it('allows listed commands and rejects unlisted ones with exit 127', async () => {
    const shell = new WasmShell({ fs, allowedCommands: ['echo'] });

    const ok = await shell.executeCommand('echo hello');
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('hello');

    const blocked = await shell.executeCommand('ls /');
    expect(blocked.exitCode).toBe(127);
    expect(blocked.stderr).toMatch(/ls/);
    expect(blocked.stderr).toMatch(/not found/i);
  });

  it('blocks disallowed commands inside a pipeline', async () => {
    const shell = new WasmShell({ fs, allowedCommands: ['echo'] });

    // `echo` is allowed but `cat` is not — the pipeline should fail at `cat`.
    const piped = await shell.executeCommand('echo hi | cat');
    expect(piped.exitCode).not.toBe(0);
    expect(piped.stderr).toMatch(/cat/);
    expect(piped.stderr).toMatch(/not found/i);
  });

  it('blocks disallowed commands inside command substitution', async () => {
    const shell = new WasmShell({ fs, allowedCommands: ['echo'] });

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
    const blockedShell = new WasmShell({ fs, allowedCommands: ['echo'] });
    const blocked = await blockedShell.executeCommand('mount');
    expect(blocked.exitCode).toBe(127);
    expect(blocked.stderr).toMatch(/mount/);
    expect(blocked.stderr).toMatch(/not found/i);

    // When `mount` is allow-listed the custom command is dispatched — even if
    // it returns non-zero for missing args, the stderr must not say
    // "command not found" (that would mean the allow-list blocked it).
    const allowedShell = new WasmShell({ fs, allowedCommands: ['mount'] });
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
    const blocked = new WasmShell({ fs, allowedCommands: ['echo'] });
    await blocked.syncJshCommands();
    const blockedResult = await blocked.executeCommand('greet');
    expect(blockedResult.exitCode).toBe(127);
    expect(blockedResult.stderr).toMatch(/not found/i);

    // With `greet` listed, the .jsh file is registered and runs normally.
    const allowed = new WasmShell({ fs, allowedCommands: ['greet'] });
    await allowed.syncJshCommands();
    const allowedResult = await allowed.executeCommand('greet');
    expect(allowedResult.exitCode).toBe(0);
    expect(allowedResult.stdout).toContain('hello from greet');
  });

  it('omits blocked commands from the /usr/bin virtual directory', async () => {
    const shell = new WasmShell({ fs, allowedCommands: ['echo', 'ls'] });

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
    // `WasmShell` always provides `fetch`, so without post-construction cleanup
    // a scoop with `allowedCommands: ['echo']` could still run `curl`. This
    // test guards the cleanup in `WasmShell`'s constructor. See Codex review
    // of #433.
    const shell = new WasmShell({ fs, allowedCommands: ['echo'] });

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
    const shell = new WasmShell({ fs, allowedCommands: ['curl'] });

    const result = await shell.executeCommand('curl');
    // curl with no args exits with usage error (2) — NOT 127. If cleanup
    // accidentally removed it, we'd see 127 / "command not found" instead.
    expect(result.exitCode).not.toBe(127);
    expect(result.stderr).not.toMatch(/not found/i);
  });
});
