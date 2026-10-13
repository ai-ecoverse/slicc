import { describe, expect, it } from 'vitest';
import { FsError } from '../../../src/fs/types.js';
import {
  loadPublication,
  MCP_SERVE_PATH,
  type McpPublication,
  savePublication,
  type TextFs,
} from '../../../src/shell/mcp/serve-store.js';

function publication(overrides: Partial<McpPublication> = {}): McpPublication {
  return {
    url: 'https://7f3a9c.sliccy.now/mcp',
    token: 'token-live',
    grantGeneration: 7,
    clis: [
      { name: 'jira', path: '/workspace/jira.jsh', helpText: 'usage: jira', commands: [] },
      { name: 'gh', path: '/workspace/gh.jsh', helpText: 'usage: gh', commands: [] },
    ],
    ...overrides,
  };
}

function memoryFs(initial?: Record<string, string>): TextFs & { writes: string[] } {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  const writes: string[] = [];
  return {
    writes,
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) {
        return Promise.reject(new FsError('ENOENT', 'missing publication', path));
      }
      return Promise.resolve(value);
    },
    writeFile: (path, content) => {
      files.set(path, content);
      writes.push(content);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
  };
}

function faultingFs(code: 'ENOENT' | 'EIO' | 'EACCES'): TextFs & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    readFile: () =>
      Promise.reject(new FsError(code, `${code} reading MCP publication`, MCP_SERVE_PATH)),
    writeFile: (_path, content) => {
      writes.push(content);
      return Promise.resolve();
    },
    exists: () => Promise.resolve(true),
    mkdir: () => Promise.resolve(),
  };
}

describe('loadPublication', () => {
  it('returns null when served.json is missing (ENOENT)', async () => {
    await expect(loadPublication(faultingFs('ENOENT'))).resolves.toBeNull();
  });

  it('returns null for an empty or literal-null file', async () => {
    await expect(loadPublication(memoryFs({ [MCP_SERVE_PATH]: '' }))).resolves.toBeNull();
    await expect(loadPublication(memoryFs({ [MCP_SERVE_PATH]: 'null' }))).resolves.toBeNull();
  });

  it('round-trips a saved publication', async () => {
    const fs = memoryFs();
    const saved = publication();
    await savePublication(fs, saved);
    await expect(loadPublication(fs)).resolves.toEqual(saved);
  });

  it('propagates a non-ENOENT FsError so callers cannot clobber live grants', async () => {
    const { writes, ...fs } = faultingFs('EIO');
    await expect(loadPublication(fs)).rejects.toThrow('EIO reading MCP publication');
    expect(writes).toEqual([]);
  });

  it('propagates EACCES the same way', async () => {
    await expect(loadPublication(faultingFs('EACCES'))).rejects.toThrow(
      'EACCES reading MCP publication'
    );
  });

  it('propagates corrupt JSON instead of treating it as unpublished', async () => {
    const fs = memoryFs({ [MCP_SERVE_PATH]: '{not-json' });
    await expect(loadPublication(fs)).rejects.toThrow(SyntaxError);
  });

  it('returns null for structurally invalid but parseable JSON', async () => {
    const fs = memoryFs({ [MCP_SERVE_PATH]: JSON.stringify({ url: 'https://x' }) });
    await expect(loadPublication(fs)).resolves.toBeNull();
  });
});
