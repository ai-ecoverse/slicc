/**
 * The panel terminal's login shell (#3530): GNU bash when a package provides
 * it (`wasm --login`), the slicc prompt when bash exits or there is none.
 */
import { describe, expect, it, vi } from 'vitest';
import { RemoteTerminalView } from '../../src/kernel/remote-terminal-view.js';
import { NO_LOGIN_SHELL, type TerminalEventMsg } from '../../src/shell/terminal-protocol.js';

type Result = { stdout: string; stderr: string; exitCode: number };

function setup(login: (resolve: (r: Result) => void) => void) {
  const view = new RemoteTerminalView({
    client: { sendRaw: vi.fn(), onTerminalEvent: () => vi.fn() },
  });
  const lines: string[] = [];
  const terminal = {
    writeln: (l: string) => void lines.push(l),
    write: vi.fn(),
    fit: vi.fn(),
    remove: vi.fn(),
  };
  const exec = vi.fn(() => new Promise<Result>((resolve) => login(resolve)));
  const stdin = vi.fn();
  const loop = vi.fn(async () => {});
  const state = view as unknown as Record<string, unknown>;
  state.client = { exec, stdin, close: vi.fn(), dispose: vi.fn() };
  state.runPromptLoop = loop;
  state.terminal = terminal;
  const start = () =>
    (Reflect.get(view, 'startSession') as (t: object) => Promise<void>).call(view, terminal);
  const event = (e: object) =>
    (Reflect.get(view, 'handleEvent') as (e: TerminalEventMsg) => void).call(
      view,
      e as TerminalEventMsg
    );
  return { view, lines, exec, stdin, loop, start, event };
}

describe('RemoteTerminalView login shell', () => {
  it('a programmatic command during the login probe waits for the prompt, not "busy"', async () => {
    let answer!: (r: Result) => void;
    const s = setup((resolve) => (answer = resolve));
    const editor = { isReading: true, text: '', setLine: vi.fn(), accept: vi.fn(), abort: vi.fn() };
    (s.view as unknown as { editor: object }).editor = editor;
    const started = s.start();
    const typed = s.view.executeCommandInTerminal('echo hi');
    await Promise.resolve();
    expect(editor.setLine).not.toHaveBeenCalled(); // still probing
    answer({ stdout: '', stderr: '', exitCode: NO_LOGIN_SHELL });
    await started;
    await vi.waitFor(() => expect(editor.setLine).toHaveBeenCalledWith('echo hi'));
    expect(editor.accept).toHaveBeenCalled();
    s.view.dispose();
    void typed;
  });

  it('`wasm --login` typed at the slicc prompt runs bash as the login shell again', async () => {
    let finish!: (r: Result) => void;
    const s = setup((resolve) => (finish = resolve));
    const line = (Reflect.get(s.view, 'processLine') as (l: string) => Promise<Result>).call(
      s.view,
      ' wasm --login '
    );
    await Promise.resolve();
    s.event({ type: 'terminal-mode', sid: 's', mode: 'pty' });
    s.event({ type: 'terminal-output', sid: 's', stream: 'stdout', data: '\x1b]7777;0\x07/ $ ' });
    const typed = s.view.executeCommandInTerminal('echo hi');
    expect(s.stdin).toHaveBeenLastCalledWith('echo hi\r');
    s.event({
      type: 'terminal-output',
      sid: 's',
      stream: 'stdout',
      data: 'echo hi\r\nhi\r\n\x1b]7777;0\x07',
    });
    expect(await typed).toMatchObject({ stdout: 'hi\n', exitCode: 0 });
    s.event({ type: 'terminal-mode', sid: 's', mode: 'line' });
    finish({ stdout: '', stderr: '', exitCode: 0 });
    expect(await line).toMatchObject({ exitCode: 0 });
    expect(s.lines.join('\n')).toContain('bash exited (0)');
    s.view.dispose();
  });

  it('`wasm --login` without bash says so', async () => {
    const s = setup((resolve) => resolve({ stdout: '', stderr: '', exitCode: NO_LOGIN_SHELL }));
    const r = await (Reflect.get(s.view, 'processLine') as (l: string) => Promise<Result>).call(
      s.view,
      'wasm --login'
    );
    expect(r).toMatchObject({
      exitCode: NO_LOGIN_SHELL,
      stderr: expect.stringContaining('wasm-bash'),
    });
    s.view.dispose();
  });

  it('without GNU bash: the slicc banner and prompt, as before', async () => {
    const s = setup((resolve) => resolve({ stdout: '', stderr: '', exitCode: NO_LOGIN_SHELL }));
    await s.start();
    expect(s.exec).toHaveBeenCalledWith('wasm --login', { discardCapturedOutput: true });
    expect(s.lines.join('\n')).toContain('Type "help"');
    expect(s.loop).toHaveBeenCalled();
    s.view.dispose();
  });

  it('runs bash first; "run in terminal" types into it and gets its result; the slicc prompt follows its exit', async () => {
    let finish!: (r: Result) => void;
    const s = setup((resolve) => (finish = resolve));
    const started = s.start();
    await Promise.resolve();
    s.event({ type: 'terminal-mode', sid: 's', mode: 'pty' });
    // Before the first prompt mark there is nothing to collect a result by.
    expect(await s.view.executeCommandInTerminal('true')).toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    s.event({ type: 'terminal-output', sid: 's', stream: 'stdout', data: '\x1b]7777;0\x07/ $ ' });
    const typed = s.view.executeCommandInTerminal('  ls -la  ');
    expect(s.stdin).toHaveBeenLastCalledWith('ls -la\r');
    expect(await s.view.executeCommandInTerminal('pwd')).toMatchObject({ exitCode: 1 }); // busy
    s.event({
      type: 'terminal-output',
      sid: 's',
      stream: 'stdout',
      data: 'ls -la\r\nfile\r\n\x1b]7777;0\x07/ $ ',
    });
    expect(await typed).toEqual({ stdout: 'file\n', stderr: '', exitCode: 0 });
    expect(s.loop).not.toHaveBeenCalled();
    s.event({ type: 'terminal-mode', sid: 's', mode: 'line' });
    finish({ stdout: '', stderr: '', exitCode: 3 });
    await started;
    expect(s.lines.join('\n')).toContain('bash exited (3)');
    expect(s.lines.join('\n')).not.toContain('Type "help"');
    expect(s.loop).toHaveBeenCalled();
    s.view.dispose();
  });
});
