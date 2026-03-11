import { describe, expect, it } from 'vitest';
import * as tools from './index.js';

describe('tools/index exports', () => {
  it('keeps the shared tool factories exported', () => {
    expect(tools.createFileTools).toBeTypeOf('function');
    expect(tools.createBashTool).toBeTypeOf('function');
    expect(tools.createSearchTools).toBeTypeOf('function');
    expect(tools.createJavaScriptTool).toBeTypeOf('function');
  });

  it('does not export the removed browser tool factory', () => {
    expect('createBrowserTool' in tools).toBe(false);
  });
});