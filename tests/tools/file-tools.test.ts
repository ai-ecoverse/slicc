import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/index.js';
import { createFileTools } from './file-tools.js';
import type { ToolDefinition } from '../core/types.js';

describe('File Tools', () => {
  let fs: VirtualFS;
  let tools: ToolDefinition[];
  let readFile: ToolDefinition;
  let writeFile: ToolDefinition;
  let editFile: ToolDefinition;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-file-tools-${dbCounter++}`,
      wipe: true,
    });
    tools = createFileTools(fs);
    readFile = tools.find((t) => t.name === 'read_file')!;
    writeFile = tools.find((t) => t.name === 'write_file')!;
    editFile = tools.find((t) => t.name === 'edit_file')!;
  });

  it('creates three tools', () => {
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'write_file', 'edit_file']);
  });

  describe('write_file', () => {
    it('writes a file', async () => {
      const result = await writeFile.execute({ path: '/hello.txt', content: 'Hello!' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('/hello.txt');
    });

    it('creates parent directories', async () => {
      const result = await writeFile.execute({ path: '/a/b/c.txt', content: 'deep' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('read_file', () => {
    it('reads a file with line numbers', async () => {
      await fs.writeFile('/test.txt', 'line1\nline2\nline3');
      const result = await readFile.execute({ path: '/test.txt' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('1 | line1');
      expect(result.content).toContain('2 | line2');
      expect(result.content).toContain('3 | line3');
    });

    it('supports offset and limit', async () => {
      await fs.writeFile('/lines.txt', 'a\nb\nc\nd\ne');
      const result = await readFile.execute({ path: '/lines.txt', offset: 2, limit: 2 });
      expect(result.content).toContain('2 | b');
      expect(result.content).toContain('3 | c');
      expect(result.content).not.toContain('1 | a');
      expect(result.content).not.toContain('4 | d');
    });

    it('returns error for non-existent file', async () => {
      const result = await readFile.execute({ path: '/nope.txt' });
      expect(result.isError).toBe(true);
    });
  });

  describe('edit_file', () => {
    it('replaces a unique string', async () => {
      await fs.writeFile('/edit.txt', 'Hello World');
      const result = await editFile.execute({
        path: '/edit.txt',
        old_string: 'World',
        new_string: 'VirtualFS',
      });
      expect(result.isError).toBeFalsy();

      const content = await fs.readTextFile('/edit.txt');
      expect(content).toBe('Hello VirtualFS');
    });

    it('errors when old_string not found', async () => {
      await fs.writeFile('/edit.txt', 'Hello');
      const result = await editFile.execute({
        path: '/edit.txt',
        old_string: 'Nope',
        new_string: 'X',
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('errors when old_string is not unique', async () => {
      await fs.writeFile('/dup.txt', 'aaa bbb aaa');
      const result = await editFile.execute({
        path: '/dup.txt',
        old_string: 'aaa',
        new_string: 'xxx',
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('2 times');
    });
  });
});
