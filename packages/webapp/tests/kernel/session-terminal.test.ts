import { describe, expect, it } from 'vitest';
import { SessionTerminal } from '../../src/kernel/session-terminal.js';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

function setup() {
  const output: string[] = [];
  const modes: string[] = [];
  const terminal = new SessionTerminal({
    output: (t) => void output.push(t),
    mode: (m) => void modes.push(m),
  });
  return { terminal, output, modes };
}

describe('SessionTerminal', () => {
  it('lends the terminal to one program at a time, in pty mode while held', () => {
    const { terminal, modes } = setup();
    const lease = terminal.lease();
    expect(lease).not.toBeNull();
    expect(terminal.lease()).toBeNull();
    lease!.release();
    lease!.release();
    expect(modes).toEqual(['pty', 'line']);
    expect(terminal.lease()).not.toBeNull();
  });

  it('routes keystrokes and resizes to the holder, and drops them otherwise', () => {
    const { terminal } = setup();
    terminal.input('ignored');
    terminal.resize(120, 40);
    const lease = terminal.lease()!;
    expect([lease.cols, lease.rows]).toEqual([120, 40]);
    const keys: string[] = [];
    const sizes: string[] = [];
    lease.onInput((b) => keys.push(text(b)));
    lease.onResize((c, r) => sizes.push(`${c}x${r}`));
    terminal.input('ls\r');
    terminal.resize(80, 24);
    terminal.resize(0, 0);
    expect(keys).toEqual(['ls\r']);
    expect(sizes).toEqual(['80x24']);
  });

  it('shows output as written, joining a UTF-8 character split across writes', () => {
    const { terminal, output } = setup();
    const lease = terminal.lease()!;
    const euro = new TextEncoder().encode('€!');
    lease.write(euro.subarray(0, 2));
    lease.write(euro.subarray(2));
    lease.release();
    lease.write(new TextEncoder().encode('late'));
    expect(output.join('')).toBe('€!');
  });
});
