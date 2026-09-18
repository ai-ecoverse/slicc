import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RestrictedFS, VirtualFS } from '../../src/fs/index.js';
import { DEV_NULL } from '../../src/fs/virtual-device-paths.js';
import { createFileTools } from '../../src/tools/file-tools.js';
import type { ToolDefinition } from '../../src/tools/types.js';

describe('File Tools', () => {
  let fs: VirtualFS;
  let tools: ToolDefinition[];
  let readFile: ToolDefinition;
  let writeFile: ToolDefinition;
  let edit: ToolDefinition;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-file-tools-${dbCounter++}`,
      wipe: true,
    });
    tools = createFileTools(fs);
    readFile = tools.find((t) => t.name === 'read_file')!;
    writeFile = tools.find((t) => t.name === 'write_file')!;
    edit = tools.find((t) => t.name === 'edit')!;
  });

  it('creates three tools', () => {
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'write_file', 'edit']);
  });

  describe('write_file', () => {
    it('writes a file', async () => {
      const result = await writeFile.execute({ path: '/hello.txt', content: 'Hello!' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('/hello.txt');

      await expect(fs.readTextFile('/hello.txt')).resolves.toBe('Hello!');
    });

    it('creates parent directories', async () => {
      const result = await writeFile.execute({ path: '/a/b/c.txt', content: 'deep' });
      expect(result.isError).toBeFalsy();
      await expect(fs.readTextFile('/a/b/c.txt')).resolves.toBe('deep');
    });

    it('returns isError when writeFile resolves but the path is not readable', async () => {
      fs.writeFile = async () => {};
      const result = await writeFile.execute({ path: '/phantom.txt', content: 'never landed' });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Write did not land/);
      expect(result.content).toContain('/phantom.txt');
      expect(result.content).not.toContain('File written:');
    });

    it('returns isError when indexed stat looks fine but readback fails (OPFS split-brain)', async () => {
      const realWrite = fs.writeFile.bind(fs);
      fs.writeFile = async (path: string, content: string | Uint8Array) => {
        await realWrite(path, content);
      };
      fs.stat = async () => ({ type: 'file', size: 12, mtime: 0, ctime: 0 });
      fs.readTextFile = async () => {
        throw new Error("ENOENT: no such file or directory, open '/ghost.txt'");
      };
      const result = await writeFile.execute({ path: '/ghost.txt', content: 'never landed' });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Write did not land/);
      expect(result.content).toMatch(/not readable|ENOENT/);
      expect(result.content).not.toContain('File written:');
    });

    it('returns isError when writeFile resolves but content does not match', async () => {
      const realWrite = fs.writeFile.bind(fs);
      fs.writeFile = async (path: string) => {
        await realWrite(path, 'x');
      };
      const result = await writeFile.execute({ path: '/trunc.txt', content: 'expected-full' });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/content mismatch/);
      expect(result.content).not.toContain('File written:');
    });

    it('succeeds when stat size diverges from content length but readback matches', async () => {
      const realWrite = fs.writeFile.bind(fs);
      const realRead = fs.readTextFile.bind(fs);
      fs.writeFile = async (path: string, content: string | Uint8Array) => {
        await realWrite(path, content);
      };
      fs.stat = async () => ({ type: 'file', size: 999999, mtime: 0, ctime: 0 });
      fs.readTextFile = async (path: string) => realRead(path);
      const result = await writeFile.execute({ path: '/aem-like.txt', content: 'payload' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('File written:');
      await expect(realRead('/aem-like.txt')).resolves.toBe('payload');
    });

    it('propagates writeFile failures without a success string', async () => {
      fs.writeFile = async () => {
        throw new Error('EACCES: permission denied, write /locked.txt');
      };
      const result = await writeFile.execute({ path: '/locked.txt', content: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/EACCES|permission denied/);
      expect(result.content).not.toContain('File written:');
    });

    it('accepts nonempty writes to /dev/null without a false durability error', async () => {
      const rfs = new RestrictedFS(fs, ['/workspace']);
      const [nullWrite] = createFileTools(rfs as unknown as VirtualFS).filter(
        (t) => t.name === 'write_file'
      );
      const result = await nullWrite.execute({
        path: DEV_NULL,
        content: 'discarded-but-accepted',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toBe(`File written: ${DEV_NULL}`);
    });
  });

  describe('read_file', () => {
    it('returns file contents raw and un-numbered (pi-aligned)', async () => {
      await fs.writeFile('/test.txt', 'line1\nline2\nline3');
      const result = await readFile.execute({ path: '/test.txt' });
      expect(result.isError).toBeFalsy();

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

    const bodyOf = (content: string): string => content.split('\n\n[')[0];

    it('caps a large file at DEFAULT_MAX_LINES with a continuation footer (#2009)', async () => {
      const totalLines = DEFAULT_MAX_LINES + 500;
      const raw = Array.from({ length: totalLines }, (_, i) => `line-${i + 1}`).join('\n');
      await fs.writeFile('/big.txt', raw);

      const result = await readFile.execute({ path: '/big.txt' });

      expect(result.isError).toBeFalsy();

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

      expect(result.content).not.toContain('Use offset=');
    });

    describe("parity with pi-agent's read tool", () => {
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

  describe('edit (Pi)', () => {
    it("exposes Pi's path + edits contract", () => {
      expect(edit.inputSchema.required).toEqual(['path', 'edits']);
      expect(edit.inputSchema.properties).toHaveProperty('edits');
      expect(edit.inputSchema.properties).not.toHaveProperty('old_string');
    });

    it('replaces a unique string', async () => {
      await fs.writeFile('/edit.txt', 'Hello World');
      const result = await edit.execute({
        path: '/edit.txt',
        edits: [{ oldText: 'World', newText: 'VirtualFS' }],
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toBe('Successfully replaced 1 block(s) in /edit.txt.');

      const content = await fs.readTextFile('/edit.txt');
      expect(content).toBe('Hello VirtualFS');
    });

    it('treats replacement $-sequences literally instead of as String.replace tokens', async () => {
      await fs.writeFile('/dollars.md', 'before TARGET after');

      await edit.execute({
        path: '/dollars.md',
        edits: [{ oldText: 'TARGET', newText: 'write a Markdown note containing `$` safely' }],
      });

      expect(await fs.readTextFile('/dollars.md')).toBe(
        'before write a Markdown note containing `$` safely after'
      );
    });

    it('applies multiple disjoint edits against the original file', async () => {
      await fs.writeFile('/multi.txt', 'alpha\nbeta\ngamma\n');

      const result = await edit.execute({
        path: '/multi.txt',
        edits: [
          { oldText: 'alpha', newText: 'one' },
          { oldText: 'gamma', newText: 'three' },
        ],
      });

      expect(result.content).toBe('Successfully replaced 2 block(s) in /multi.txt.');
      expect(await fs.readTextFile('/multi.txt')).toBe('one\nbeta\nthree\n');
    });

    it("serializes concurrent edits to the same file through Pi's mutation queue", async () => {
      await fs.writeFile('/concurrent.txt', 'alpha beta');

      await Promise.all([
        edit.execute({
          path: '/concurrent.txt',
          edits: [{ oldText: 'alpha', newText: 'one' }],
        }),
        edit.execute({
          path: '/concurrent.txt',
          edits: [{ oldText: 'beta', newText: 'two' }],
        }),
      ]);

      expect(await fs.readTextFile('/concurrent.txt')).toBe('one two');
    });

    it('resolves relative paths from the work-unit cwd', async () => {
      await fs.writeFile('/scoops/vanilla/workspace/note.txt', 'old');
      const scopedEdit = createFileTools(fs, '/scoops/vanilla/workspace').find(
        (tool) => tool.name === 'edit'
      )!;

      await scopedEdit.execute({
        path: 'note.txt',
        edits: [{ oldText: 'old', newText: 'new' }],
      });

      expect(await fs.readTextFile('/scoops/vanilla/workspace/note.txt')).toBe('new');
    });

    it('preserves a UTF-8 BOM and CRLF line endings', async () => {
      await fs.writeFile('/windows.txt', '\uFEFFalpha\r\nbeta\r\n');

      await edit.execute({
        path: '/windows.txt',
        edits: [{ oldText: 'beta', newText: 'gamma' }],
      });

      expect(await fs.readTextFile('/windows.txt')).toBe('\uFEFFalpha\r\ngamma\r\n');
    });

    it("forwards Pi's legacy camelCase argument preparation", () => {
      expect(
        edit.prepareArguments?.({ path: '/edit.txt', oldText: 'old', newText: 'new' })
      ).toEqual({
        path: '/edit.txt',
        edits: [{ oldText: 'old', newText: 'new' }],
      });
    });

    it('throws when oldText is not found', async () => {
      await fs.writeFile('/edit.txt', 'Hello');
      await expect(
        edit.execute({
          path: '/edit.txt',
          edits: [{ oldText: 'Nope', newText: 'X' }],
        })
      ).rejects.toThrow('Could not find the exact text');
    });

    it("maps a missing VFS path to Pi's stable file error code", async () => {
      await expect(
        edit.execute({
          path: '/missing.txt',
          edits: [{ oldText: 'old', newText: 'new' }],
        })
      ).rejects.toThrow('Error code: not_found');
    });

    it('throws when oldText is not unique', async () => {
      await fs.writeFile('/dup.txt', 'aaa bbb aaa');
      await expect(
        edit.execute({
          path: '/dup.txt',
          edits: [{ oldText: 'aaa', newText: 'xxx' }],
        })
      ).rejects.toThrow('Found 2 occurrences');
    });

    it('rejects when the edit write resolves but the file vanishes', async () => {
      await fs.writeFile('/edit-gone.txt', 'before');
      const realWrite = fs.writeFile.bind(fs);
      const realRm = fs.rm.bind(fs);
      fs.writeFile = async (path: string, content: string | Uint8Array) => {
        await realWrite(path, content);
        await realRm(path);
      };
      await expect(
        edit.execute({
          path: '/edit-gone.txt',
          edits: [{ oldText: 'before', newText: 'after' }],
        })
      ).rejects.toThrow('Could not edit file: /edit-gone.txt. Error code: unknown.');
    });
  });
});
