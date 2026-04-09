/**
 * Tests for WasmShell utility functions.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserAPI } from '../../src/cdp/index.js';
import { VirtualFS } from '../../src/fs/index.js';
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

  afterEach(async () => {
    await fs.dispose();
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
});
