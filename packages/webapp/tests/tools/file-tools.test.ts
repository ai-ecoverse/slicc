import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
    it('returns file contents raw and un-numbered (pi-aligned)', async () => {
      await fs.writeFile('/test.txt', 'line1\nline2\nline3');
      const result = await readFile.execute({ path: '/test.txt' });
      expect(result.isError).toBeFalsy();
      // No `N | ` line-number prefix — byte-for-byte pi's read output.
      expect(result.content).toBe('line1\nline2\nline3');
    });

    it('supports offset and limit', async () => {
      await fs.writeFile('/lines.txt', 'apple\nbanana\ncherry\ndate\nelder');
      const result = await readFile.execute({ path: '/lines.txt', offset: 2, limit: 2 });
      expect(result.content.split('\n\n[')[0]).toBe('banana\ncherry');
      expect(result.content).not.toContain('apple');
      expect(result.content).not.toContain('date');
    });

    it('returns error for non-existent file', async () => {
      const result = await readFile.execute({ path: '/nope.txt' });
      expect(result.isError).toBe(true);
    });

    it('leaves a small file unchanged with no footer (#2009)', async () => {
      await fs.writeFile('/small.txt', 'alpha\nbeta\ngamma');
      const result = await readFile.execute({ path: '/small.txt' });

      expect(result.isError).toBeFalsy();
      expect(result.content).toBe('alpha\nbeta\ngamma');
    });

    // The body delivered to the model = everything before the footer.
    const bodyOf = (content: string): string => content.split('\n\n[')[0];

    it('caps a large file at DEFAULT_MAX_LINES with a continuation footer (#2009)', async () => {
      const totalLines = DEFAULT_MAX_LINES + 500;
      const raw = Array.from({ length: totalLines }, (_, i) => `line-${i + 1}`).join('\n');
      await fs.writeFile('/big.txt', raw);

      const result = await readFile.execute({ path: '/big.txt' });

      expect(result.isError).toBeFalsy();
      // Short lines → the 2000-line head window is hit before the 50KB byte cap.
      expect(bodyOf(result.content).split('\n')).toHaveLength(DEFAULT_MAX_LINES);
      expect(new TextEncoder().encode(bodyOf(result.content)).length).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES
      );
      expect(result.content).toContain(
        `[Showing lines 1-${DEFAULT_MAX_LINES} of ${totalLines}. Use offset=${DEFAULT_MAX_LINES + 1} to continue.]`
      );
      expect(result.content).toContain(`line-${DEFAULT_MAX_LINES}`);
      expect(result.content).not.toContain(`line-${totalLines}`);
    });

    it('honors the 50KB byte cap for wide lines (#2009)', async () => {
      // 300 × 1KB lines: the byte cap wins well before the 2000-line cap.
      const raw = Array.from({ length: 300 }, () => 'x'.repeat(1000)).join('\n');
      await fs.writeFile('/fat.txt', raw);

      const result = await readFile.execute({ path: '/fat.txt' });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('KB limit). Use offset=');
      expect(new TextEncoder().encode(bodyOf(result.content)).length).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES
      );
      expect(bodyOf(result.content).split('\n').length).toBeLessThan(DEFAULT_MAX_LINES);
    });

    it('reports remaining lines when the user limit stops short of EOF (#2009)', async () => {
      await fs.writeFile('/lines.txt', 'apple\nbanana\ncherry\ndate\nelder');
      const result = await readFile.execute({ path: '/lines.txt', limit: 2 });

      expect(bodyOf(result.content)).toBe('apple\nbanana');
      // 3 lines remain; paging continues from file line 3.
      expect(result.content).toContain('[3 more lines in file. Use offset=3 to continue.]');
    });

    it('continues cleanly from the offset advertised in the footer (#2009)', async () => {
      const totalLines = DEFAULT_MAX_LINES + 500;
      const raw = Array.from({ length: totalLines }, (_, i) => `line-${i + 1}`).join('\n');
      await fs.writeFile('/big.txt', raw);

      const nextOffset = DEFAULT_MAX_LINES + 1;
      const result = await readFile.execute({ path: '/big.txt', offset: nextOffset });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain(`line-${nextOffset}`);
      expect(result.content).toContain(`line-${totalLines}`);
      // The remaining 500 lines all fit, so no further footer.
      expect(result.content).not.toContain('Use offset=');
    });

    // Parity with pi-agent's ACTUAL read tool: this fails if pi changes its read
    // behavior (footer wording, offset math, 2000-line/50KB limits) so we know to
    // re-sync. pi reads from the OS fs; we mirror identical content into the VFS
    // for SLICC and compare the DELIVERED text byte-for-byte — which holds only
    // because SLICC returns pi's raw, un-numbered body.
    describe("parity with pi-agent's read tool", () => {
      // Loaded via a runtime path so tsc/vite don't resolve pi's Node-only read
      // module (hidden by the package `exports` map); it runs fine in the node
      // vitest env, where node resolves it relative to this file.
      const piReadModule =
        '../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js';
      type PiRead = {
        createReadToolDefinition: (cwd: string) => {
          execute: (
            id: string,
            args: { path: string; offset?: number; limit?: number }
          ) => Promise<{ content: Array<{ text?: string }> }>;
        };
      };
      let piDir: string;
      let piRead: (name: string, offset?: number, limit?: number) => Promise<string>;

      beforeAll(async () => {
        const pi = (await import(/* @vite-ignore */ piReadModule)) as PiRead;
        piDir = mkdtempSync(join(tmpdir(), 'pi-read-parity-'));
        const def = pi.createReadToolDefinition(piDir);
        piRead = async (name, offset, limit) => {
          const res = await def.execute('tc', { path: join(piDir, name), offset, limit });
          return (res.content ?? []).map((c) => c.text ?? '').join('');
        };
      });

      // Mirror identical content into pi's OS temp dir and SLICC's VFS.
      const both = async (name: string, content: string) => {
        writeFileSync(join(piDir, name), content);
        await fs.writeFile(`/${name}`, content);
      };
      const sliccRead = async (name: string, offset?: number, limit?: number) => {
        const res = await readFile.execute({
          path: `/${name}`,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return res.content;
      };

      it('matches pi: small file (no truncation)', async () => {
        await both('p-small.txt', 'alpha\nbeta\ngamma');
        expect(await sliccRead('p-small.txt')).toBe(await piRead('p-small.txt'));
      });

      it('matches pi: large file, no limit (line cap + footer)', async () => {
        const content = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join('\n');
        await both('p-big.txt', content);
        expect(await sliccRead('p-big.txt')).toBe(await piRead('p-big.txt'));
      });

      it('matches pi: wide lines (byte cap + footer)', async () => {
        const content = Array.from({ length: 300 }, () => 'x'.repeat(1000)).join('\n');
        await both('p-fat.txt', content);
        expect(await sliccRead('p-fat.txt')).toBe(await piRead('p-fat.txt'));
      });

      it('matches pi: offset continuation', async () => {
        const content = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join('\n');
        await both('p-off.txt', content);
        expect(await sliccRead('p-off.txt', 2001)).toBe(await piRead('p-off.txt', 2001));
      });

      it('matches pi: user limit short of EOF', async () => {
        await both('p-lim.txt', 'a\nb\nc\nd\ne');
        expect(await sliccRead('p-lim.txt', 1, 2)).toBe(await piRead('p-lim.txt', 1, 2));
      });

      it('pins pi head-window limits so a pi bump is explicit in review', () => {
        expect(DEFAULT_MAX_LINES).toBe(2000);
        expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
      });
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
