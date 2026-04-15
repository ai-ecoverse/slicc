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

describe('WasmShell .jsh command registration', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-jsh-reg-${Date.now()}`, wipe: true });
    await fs.mkdir('/workspace/skills/test-cmd/scripts', { recursive: true });
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
