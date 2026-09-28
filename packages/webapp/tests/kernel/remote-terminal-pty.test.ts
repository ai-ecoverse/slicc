import { describe, expect, it, vi } from 'vitest';
import { RemoteTerminalView } from '../../src/kernel/remote-terminal-view.js';
import type { TerminalEventMsg } from '../../src/shell/terminal-protocol.js';

function setup() {
  const sendRaw = vi.fn();
  const view = new RemoteTerminalView({ client: { sendRaw, onTerminalEvent: () => vi.fn() } });
  const written: string[] = [];
  const state = view as unknown as {
    terminal: object;
    editor: { feed: (data: string) => void };
  };
  const feed = vi.fn();
  state.terminal = {
    write: (data: string) => void written.push(data),
    writeln: vi.fn(),
    remove: vi.fn(),
    fit: vi.fn(),
    terminal: { cols: 100, rows: 30 },
  };
  state.editor = { feed, abort: vi.fn() } as never;
  const event = (e: object) =>
    (Reflect.get(view, 'handleEvent') as (e: TerminalEventMsg) => void).call(
      view,
      e as TerminalEventMsg
    );
  const type = (data: string) =>
    (Reflect.get(view, 'handleTerminalData') as (d: string) => void).call(view, data);
  const sent = () => sendRaw.mock.calls.map(([m]) => m as { type: string });
  return { view, event, type, sent, written, feed };
}

describe('RemoteTerminalView pty mode', () => {
  it('sends keystrokes raw while a program holds the terminal, and reports its size', () => {
    const { view, event, type, sent, feed } = setup();
    event({ type: 'terminal-mode', sid: 's', mode: 'pty' });
    type('ls\r');
    type('\x03');
    expect(sent()).toEqual([
      expect.objectContaining({ type: 'terminal-resize', cols: 100, rows: 30 }),
      expect.objectContaining({ type: 'terminal-stdin', data: 'ls\r' }),
      expect.objectContaining({ type: 'terminal-stdin', data: '\x03' }),
    ]);
    expect(feed).not.toHaveBeenCalled();
    event({ type: 'terminal-mode', sid: 's', mode: 'line' });
    type('x');
    expect(feed).toHaveBeenCalledWith('x');
    view.dispose();
  });

  it('shows pty output unaltered: no newline translation, no stderr tint', () => {
    const { view, event, written } = setup();
    event({ type: 'terminal-output', sid: 's', stream: 'stderr', data: 'a\nb' });
    event({ type: 'terminal-mode', sid: 's', mode: 'pty' });
    event({ type: 'terminal-output', sid: 's', stream: 'stdout', data: 'c\r\nd' });
    expect(written).toEqual(['\x1b[31ma\r\nb\x1b[0m', 'c\r\nd']);
    view.dispose();
  });
});
