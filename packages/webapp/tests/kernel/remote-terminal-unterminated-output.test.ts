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

  it('guards readNextLine with a cursorX > 0 check before readline.read', () => {
    // Match the guard inside `readNextLine`. Whitespace-tolerant so
    // trivial reformatting doesn't tank the test.
    expect(src).toMatch(
      /private\s+readNextLine[\s\S]*?this\.terminal\.buffer\.active\.cursorX\s*>\s*0[\s\S]*?readline\.read\(PROMPT\)/
    );
  });

  it('writes the reverse-video marker + CRLF so the partial line survives', () => {
    // The zsh-style `\x1b[7m%\x1b[0m\r\n` sequence: SGR reverse video,
    // literal `%`, SGR reset, then carriage-return + newline.
    expect(src).toContain(String.raw`\x1b[7m%\x1b[0m\r\n`);
  });
});
