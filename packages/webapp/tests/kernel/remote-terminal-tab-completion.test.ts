import { describe, expect, it, vi } from 'vitest';
import {
  bashSingleQuote,
  buildCompgenDirCheck,
  buildCompgenPlan,
  longestCommonPrefix,
  RemoteTerminalView,
} from '../../src/kernel/remote-terminal-view.js';
import { TerminalLineEditor } from '../../src/kernel/terminal-line-editor.js';

describe('bashSingleQuote', () => {
  it("wraps empty input as `''` so compgen still has a token", () => {
    expect(bashSingleQuote('')).toBe(`''`);
  });

  it('wraps a plain word', () => {
    expect(bashSingleQuote('foo')).toBe(`'foo'`);
  });

  it("escapes embedded single quotes with the exhaustive '\\'' form", () => {
    expect(bashSingleQuote(`won't`)).toBe(`'won'\\''t'`);
  });

  it('leaves other special characters untouched (they are safe inside single quotes)', () => {
    expect(bashSingleQuote('$HOME/some dir/file*.txt')).toBe(`'$HOME/some dir/file*.txt'`);
  });
});

describe('buildCompgenPlan', () => {
  it('uses command completion when the cursor is in the first word', () => {
    expect(buildCompgenPlan('we')).toEqual({
      currentWord: 'we',
      isFirstWord: true,
      compgenCmd: `compgen -A command -- 'we'`,
    });
  });

  it('treats leading whitespace + one token as first-word still', () => {
    expect(buildCompgenPlan('  we').isFirstWord).toBe(true);
  });

  it('uses file completion for every subsequent word', () => {
    const plan = buildCompgenPlan('cat src/some-fi');
    expect(plan.currentWord).toBe('src/some-fi');
    expect(plan.isFirstWord).toBe(false);
    expect(plan.compgenCmd).toBe(`compgen -f -- 'src/some-fi'`);
  });

  it('returns an empty current word when the line ends in whitespace', () => {
    const plan = buildCompgenPlan('cat ');
    expect(plan.currentWord).toBe('');
    expect(plan.isFirstWord).toBe(false);
    expect(plan.compgenCmd).toBe(`compgen -f -- ''`);
  });

  it('safely escapes single quotes in the prefix', () => {
    const plan = buildCompgenPlan(`ls won't-st`);
    expect(plan.compgenCmd).toBe(`compgen -f -- 'won'\\''t-st'`);
  });
});

describe('buildCompgenDirCheck', () => {
  it('quotes the completion and asks compgen -d', () => {
    expect(buildCompgenDirCheck('src')).toBe(`compgen -d -- 'src'`);
  });

  it('escapes embedded single quotes in the completion', () => {
    expect(buildCompgenDirCheck("with' space")).toBe(`compgen -d -- 'with'\\'' space'`);
  });
});

describe('longestCommonPrefix', () => {
  it('returns empty for empty input', () => {
    expect(longestCommonPrefix([])).toBe('');
  });

  it('returns the only match when there is exactly one', () => {
    expect(longestCommonPrefix(['screencapture'])).toBe('screencapture');
  });

  it('shrinks the prefix to the longest shared run', () => {
    expect(longestCommonPrefix(['screen', 'screencap', 'screencapture'])).toBe('screen');
  });

  it('returns empty when the first characters diverge', () => {
    expect(longestCommonPrefix(['alpha', 'beta'])).toBe('');
  });

  it('handles paths correctly (no special treatment of /)', () => {
    expect(longestCommonPrefix(['src/foo.ts', 'src/foo-bar.ts'])).toBe('src/foo');
  });
});

describe('completion input', () => {
  it('replays typing and Enter received while compgen is pending', async () => {
    let finishCompgen!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const compgen = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      finishCompgen = resolve;
    });
    const view = new RemoteTerminalView({
      client: { sendRaw: vi.fn(), onTerminalEvent: () => vi.fn() },
    });
    const editor = new TerminalLineEditor({
      write: vi.fn(),
      getCursor: () => ({ row: 0, col: 0 }),
      getScrollbackCount: () => 0,
    });
    const state = view as unknown as {
      terminal: { writeln: () => void; remove: () => void };
      editor: TerminalLineEditor;
      client: { exec: () => Promise<{ stdout: string; stderr: string; exitCode: number }> };
    };
    state.terminal = { writeln: vi.fn(), remove: vi.fn() };
    state.editor = editor;
    state.client.exec = vi.fn(() => compgen);
    const read = editor.read('$ ');
    editor.insert('ec');
    const input = Reflect.get(view, 'handleTerminalData') as (data: string) => void;
    input.call(view, '\t');
    input.call(view, 'h');
    input.call(view, '\r');
    expect(editor.text).toBe('ec');
    finishCompgen({ stdout: 'echo\n', stderr: '', exitCode: 0 });
    expect(await read).toBe('echo h');
    view.dispose();
  });
});
