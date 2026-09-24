import { describe, expect, it } from 'vitest';
import {
  type TerminalLineDisplay,
  TerminalLineEditor,
} from '../../src/kernel/terminal-line-editor.js';

function display(col = 0): TerminalLineDisplay & { output: string[] } {
  const output: string[] = [];
  return {
    output,
    write: (data) => output.push(data),
    getCursor: () => ({ row: 0, col }),
    getScrollbackCount: () => 0,
  };
}

describe('TerminalLineEditor', () => {
  it('edits a wrapped-length line at the cursor and commits the visible command', async () => {
    const editor = new TerminalLineEditor(display());
    const read = editor.read('$ ');
    editor.insert('abcdefghijklmnop');
    editor.feed('\x1b[D');
    editor.feed('\x1b[D');
    editor.feed('\x7f');
    editor.insert('X');
    expect(editor.text).toBe('abcdefghijklmXop');
    expect(editor.beforeCursor).toBe('abcdefghijklmX');
    editor.feed('\r');
    expect(await read).toBe('abcdefghijklmXop');
  });

  it('keeps history in memory and restores a draft after Down', async () => {
    const editor = new TerminalLineEditor(display());
    const first = editor.read('$ ');
    editor.insert('echo one');
    editor.accept();
    await first;

    const second = editor.read('$ ');
    editor.insert('draft');
    editor.feed('\x1b[A');
    expect(editor.text).toBe('echo one');
    editor.feed('\x1b[B');
    expect(editor.text).toBe('draft');
    editor.accept();
    await second;
  });

  it('cancels an edited line on Ctrl+C and preserves unterminated output', async () => {
    const terminal = display(3);
    const editor = new TerminalLineEditor(terminal);
    const read = editor.read('$ ');
    editor.insert('secret');
    editor.feed('\x03');
    expect(await read).toBe('');
    expect(terminal.output).toContain('\x1b[7m%\x1b[0m\r\n');
    expect(terminal.output).toContain('^C\r\n');
  });

  it('inserts completion before text after the cursor', async () => {
    const editor = new TerminalLineEditor(display());
    const read = editor.read('$ ');
    editor.insert('cat fo tail');
    for (let n = 0; n < 5; n++) editor.feed('\x1b[D');
    editor.insert('obar');
    expect(editor.text).toBe('cat foobar tail');
    editor.accept();
    await read;
  });

  it('keeps a multiline paste in the editable line until Enter', async () => {
    const editor = new TerminalLineEditor(display());
    const read = editor.read('$ ');
    editor.feed('echo first\nsecond');
    expect(editor.text).toBe('echo first second');
    expect(editor.isReading).toBe(true);
    editor.feed('\r');
    expect(await read).toBe('echo first second');
  });
});
