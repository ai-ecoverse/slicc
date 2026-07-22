/**
 * Regression pin for the "unterminated output erased by prompt redraw" bug.
 *
 * Root cause (issue #1583): `readline.read(PROMPT)` in `readNextLine()`
 * anchors the prompt at the current row and issues a carriage-return +
 * line clear before drawing, which wipes whatever the preceding
 * `terminal-output` event wrote without a trailing newline (`echo -n ABC`,
 * `cat` on a file missing its final `\n`, …).
 *
 * Fix: before entering `readline.read(PROMPT)`, check
 * `terminal.buffer.active.cursorX > 0` and, when the cursor isn't at
 * column 0, emit the zsh-style reverse-video `%` marker followed by
 * `\r\n` so the partial line survives.
 *
 * `terminal.write()` is asynchronous — it queues data into the xterm.js
 * parser and updates `cursorX` on a subsequent tick. Reading `cursorX`
 * synchronously observes stale state, so the check has to run inside an
 * empty-write flush callback (`terminal.write('', () => …)`), which fires
 * only after the parser has drained the queued `terminal-output` bytes.
 *
 * `readNextLine` is a module-private method that depends on the xterm.js
 * DOM buffer, so it isn't unit-testable without a full browser
 * environment. This test asserts the fix is present in the source — the
 * same pattern the mount test uses for the `storePendingHandle`
 * regression — so bundle-shape or refactor drift can't silently
 * reintroduce the bug.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('regression #1583: unterminated output survives prompt redraw', () => {
  const REMOTE_TERMINAL_VIEW = resolve(__dirname, '../../src/kernel/remote-terminal-view.ts');
  const src = readFileSync(REMOTE_TERMINAL_VIEW, 'utf8');
  // Isolate the readNextLine body so assertions can't be satisfied by
  // unrelated matches elsewhere in the file.
  const readNextLineBody = src.match(/private\s+readNextLine\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';

  it('extracts the readNextLine body from the source', () => {
    expect(readNextLineBody).not.toBe('');
  });

  it('runs the cursorX check inside a terminal.write flush callback', () => {
    // xterm.js `write(data, callback)` fires the callback only after the
    // parser has drained the queued bytes. The cursor check MUST live
    // inside that callback, otherwise pending `terminal-output` bytes
    // from the previous command haven't been parsed and `cursorX` reads
    // stale — the exact race the reviewer flagged on #1607.
    expect(readNextLineBody).toMatch(
      /terminal\.write\(\s*''\s*,\s*\(\)\s*=>\s*\{[\s\S]*?buffer\.active\.cursorX\s*>\s*0[\s\S]*?readline\.read\(PROMPT\)/
    );
  });

  it('writes the reverse-video marker + CRLF so the partial line survives', () => {
    // The zsh-style `\x1b[7m%\x1b[0m\r\n` sequence: SGR reverse video,
    // literal `%`, SGR reset, then carriage-return + newline.
    expect(readNextLineBody).toContain(String.raw`\x1b[7m%\x1b[0m\r\n`);
  });
});
