import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('regression #1583: unterminated output survives prompt redraw', () => {
  const REMOTE_TERMINAL_VIEW = resolve(__dirname, '../../src/kernel/remote-terminal-view.ts');
  const src = readFileSync(REMOTE_TERMINAL_VIEW, 'utf8');

  const readNextLineBody = src.match(/private\s+readNextLine\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';

  it('extracts the readNextLine body from the source', () => {
    expect(readNextLineBody).not.toBe('');
  });

  it('runs the cursorX check inside a terminal.write flush callback', () => {
    expect(readNextLineBody).toMatch(
      /terminal\.write\(\s*''\s*,\s*\(\)\s*=>\s*\{[\s\S]*?buffer\.active\.cursorX\s*>\s*0[\s\S]*?readline\.read\(PROMPT\)/
    );
  });

  it('writes the reverse-video marker + CRLF so the partial line survives', () => {
    expect(readNextLineBody).toContain(String.raw`\x1b[7m%\x1b[0m\r\n`);
  });
});
