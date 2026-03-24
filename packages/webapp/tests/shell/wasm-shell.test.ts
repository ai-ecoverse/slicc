/**
 * Tests for WasmShell utility functions.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserAPI } from '../../src/cdp/index.js';
import { VirtualFS } from '../../src/fs/index.js';
import { isTextContentType, WasmShell } from '../../src/shell/wasm-shell.js';

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
});
