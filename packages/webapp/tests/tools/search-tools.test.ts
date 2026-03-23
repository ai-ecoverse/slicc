import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { createSearchTools } from '../../src/tools/search-tools.js';
import type { ToolDefinition } from '../../src/core/types.js';

describe('Search Tools', () => {
  let fs: VirtualFS;
  let grep: ToolDefinition;
  let find: ToolDefinition;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-search-tools-${dbCounter++}`,
      wipe: true,
    });
    const tools = createSearchTools(fs);
    grep = tools.find((t) => t.name === 'grep')!;
    find = tools.find((t) => t.name === 'find')!;

    // Set up test files
    await fs.writeFile('/src/main.ts', 'import { foo } from "../../src/tools/foo";\nconsole.log(foo());\n');
    await fs.writeFile('/src/foo.ts', 'export function foo() {\n  return "bar";\n}\n');
    await fs.writeFile('/readme.md', '# Test Project\nThis is a test.\n');
  });

  describe('grep', () => {
    it('finds matches across files', async () => {
      const result = await grep.execute({ pattern: 'foo' });
      expect(result.content).toContain('/src/main.ts');
      expect(result.content).toContain('/src/foo.ts');
    });

    it('shows line numbers', async () => {
      const result = await grep.execute({ pattern: 'console' });
      expect(result.content).toContain(':2:');
    });

    it('returns no matches message', async () => {
      const result = await grep.execute({ pattern: 'zzzznotfound' });
      expect(result.content).toBe('No matches found.');
    });

    it('supports regex patterns', async () => {
      const result = await grep.execute({ pattern: 'function\\s+\\w+' });
      expect(result.content).toContain('foo.ts');
    });

    it('filters by include pattern', async () => {
      const result = await grep.execute({ pattern: 'test', include: '*.md', path: '/' });
      expect(result.content).toContain('readme.md');
      expect(result.content).not.toContain('.ts');
    });

    it('scopes to a specific path', async () => {
      const result = await grep.execute({ pattern: '.*', path: '/src' });
      expect(result.content).not.toContain('readme.md');
    });
  });

  describe('find', () => {
    it('finds all files', async () => {
      const result = await find.execute({ path: '/' });
      expect(result.content).toContain('/src/main.ts');
      expect(result.content).toContain('/src/foo.ts');
      expect(result.content).toContain('/readme.md');
    });

    it('filters by glob pattern', async () => {
      const result = await find.execute({ pattern: '*.ts', path: '/' });
      expect(result.content).toContain('main.ts');
      expect(result.content).toContain('foo.ts');
      expect(result.content).not.toContain('readme.md');
    });

    it('filters by deep glob', async () => {
      const result = await find.execute({ pattern: 'src/**/*.ts', path: '/' });
      expect(result.content).toContain('/src/main.ts');
    });

    it('returns no files message', async () => {
      const result = await find.execute({ pattern: '*.xyz', path: '/' });
      expect(result.content).toBe('No files found.');
    });
  });
});
