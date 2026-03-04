/**
 * Tests for the JavaScript runtime tool.
 *
 * The tool relies on iframe + postMessage, so we can only test
 * the tool definition shape and error paths in a Node test environment.
 * Full execution tests require a browser context.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/index.js';
import { createJavaScriptTool } from './javascript-tool.js';
import type { ToolDefinition } from '../core/types.js';

describe('JavaScript Tool', () => {
  let fs: VirtualFS;
  let tool: ToolDefinition;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      backend: 'indexeddb',
      dbName: `test-js-tool-${dbCounter++}`,
    });
    tool = createJavaScriptTool(fs);
  });

  it('has correct name', () => {
    expect(tool.name).toBe('javascript');
  });

  it('has a description', () => {
    expect(tool.description).toBeTruthy();
    expect(tool.description).toContain('JavaScript');
  });

  it('requires code parameter', () => {
    expect(tool.inputSchema.required).toContain('code');
  });

  it('defines code and timeout properties', () => {
    const props = tool.inputSchema.properties as Record<string, { type: string }>;
    expect(props['code']).toBeDefined();
    expect(props['code'].type).toBe('string');
    expect(props['timeout']).toBeDefined();
    expect(props['timeout'].type).toBe('number');
  });

  it('returns error when DOM is not available', async () => {
    // In Node, document.createElement('iframe') throws
    const result = await tool.execute({ code: 'return 1 + 1' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('error');
  });
});
