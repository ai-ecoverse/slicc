import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { createFileTools } from '../../src/tools/file-tools.js';
import type { ToolDefinition } from '../../src/tools/types.js';

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

    it('leaves a small file unchanged with no footer (#2009)', async () => {
      await fs.writeFile('/small.txt', 'alpha\nbeta\ngamma');
      const result = await readFile.execute({ path: '/small.txt' });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('1 | alpha');
      expect(result.content).toContain('2 | beta');
      expect(result.content).toContain('3 | gamma');
      // No truncation happened, so no continuation footer.
      expect(result.content).not.toContain('Use offset=');
      expect(result.content).not.toContain('more lines in file');
    });

    // Reconstruct the underlying (un-prefixed) content that truncateHead capped,
    // by stripping SLICC's `      N | ` line-number prefix from each body line.
    const underlyingContent = (content: string): string =>
      content
        .split('\n\n[')[0] // drop the footer
        .split('\n')
        .map((l) => l.replace(/^\s*\d+ \| /, ''))
        .join('\n');
    const numberedLines = (content: string): string[] =>
      content
        .split('\n\n[')[0]
        .split('\n')
        .filter((l) => /^\s*\d+ \| /.test(l));

    it('caps a large file with NO limit and appends a continuation footer (#2009)', async () => {
      // Well over the 2000-line head window; short lines → truncated BY LINES.
      const totalLines = DEFAULT_MAX_LINES + 500;
      const raw = Array.from({ length: totalLines }, (_, i) => `line-${i + 1}`).join('\n');
      await fs.writeFile('/big.txt', raw);

      const result = await readFile.execute({ path: '/big.txt' });

      expect(result.isError).toBeFalsy();
      // Output is bounded to exactly the 2000-line head window — well under the
      // 2500 lines actually in the file.
      expect(numberedLines(result.content)).toHaveLength(DEFAULT_MAX_LINES);
      expect(DEFAULT_MAX_LINES).toBeLessThan(totalLines);
      // The underlying (un-prefixed) content honors pi's byte cap too.
      expect(
        new TextEncoder().encode(underlyingContent(result.content)).length
      ).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      // Continuation footer points at the next file line to page from.
      expect(result.content).toContain(
        `[Showing lines 1-${DEFAULT_MAX_LINES} of ${totalLines}. Use offset=${DEFAULT_MAX_LINES + 1} to continue.]`
      );
      // Last surviving numbered line is the 2000th file line, not the last.
      expect(result.content).toContain(`${DEFAULT_MAX_LINES} | line-${DEFAULT_MAX_LINES}`);
      expect(result.content).not.toContain(`| line-${totalLines}`);
    });

    it('honors the exact 50KB byte cap when line count is under the limit (#2009)', async () => {
      // 300 lines, each ~1KB → ~300KB total, but only ~50 lines fit in 50KB, so
      // the line count stays under DEFAULT_MAX_LINES and the BYTE cap wins.
      const fatLine = 'x'.repeat(1000);
      const totalLines = 300;
      const raw = Array.from({ length: totalLines }, () => fatLine).join('\n');
      await fs.writeFile('/fat.txt', raw);

      const result = await readFile.execute({ path: '/fat.txt' });

      expect(result.isError).toBeFalsy();
      // Truncated by BYTES (line count is under DEFAULT_MAX_LINES), so the footer
      // names the byte limit and stops well short of all 300 lines.
      expect(result.content).toContain('KB limit). Use offset=');
      const shown = numberedLines(result.content).length;
      expect(shown).toBeLessThan(totalLines);
      expect(shown).toBeLessThan(DEFAULT_MAX_LINES);
      // The underlying content (what truncateHead sized) fits inside the 50KB cap.
      expect(
        new TextEncoder().encode(underlyingContent(result.content)).length
      ).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    });

    it('reports remaining lines when the user limit stops short of EOF (#2009)', async () => {
      await fs.writeFile('/lines.txt', 'a\nb\nc\nd\ne');
      const result = await readFile.execute({ path: '/lines.txt', limit: 2 });

      expect(result.content).toContain('1 | a');
      expect(result.content).toContain('2 | b');
      expect(result.content).not.toContain('3 | c');
      // 3 lines remain (c, d, e); paging continues from file line 3.
      expect(result.content).toContain('[3 more lines in file. Use offset=3 to continue.]');
    });

    it('continues cleanly from the offset advertised in the footer (#2009)', async () => {
      const totalLines = DEFAULT_MAX_LINES + 500;
      const raw = Array.from({ length: totalLines }, (_, i) => `line-${i + 1}`).join('\n');
      await fs.writeFile('/big.txt', raw);

      // First window told us to continue at DEFAULT_MAX_LINES + 1.
      const nextOffset = DEFAULT_MAX_LINES + 1;
      const result = await readFile.execute({ path: '/big.txt', offset: nextOffset });

      expect(result.isError).toBeFalsy();
      // Numbers continue from the file line number, not restart at 1.
      expect(result.content).toContain(`${nextOffset} | line-${nextOffset}`);
      expect(result.content).toContain(`${totalLines} | line-${totalLines}`);
      // The remaining 500 lines all fit, so no further footer.
      expect(result.content).not.toContain('Use offset=');
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
