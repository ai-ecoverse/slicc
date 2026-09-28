import { describe, expect, it } from 'vitest';
import { LOGIN_PROMPT_COMMAND, LoginShellMarks } from '../../src/kernel/login-shell-marks.js';

const mark = (status: number) => `\x1b]7777;${status}\x07`;

describe('LoginShellMarks', () => {
  it('shows the output without its marks, and knows the shell prints them', () => {
    const marks = new LoginShellMarks();
    expect(marks.seen).toBe(false);
    expect(marks.filter(`welcome\r\n${mark(0)}/ $ `)).toBe('welcome\r\n/ $ ');
    expect(marks.seen).toBe(true);
    expect(LOGIN_PROMPT_COMMAND).toContain('7777');
  });

  it('collects a typed command’s output (without its echo) and status up to the next mark', async () => {
    const marks = new LoginShellMarks();
    marks.filter(`${mark(0)}/ $ `);
    const result = marks.expect();
    expect(marks.pending).toBe(true);

    expect(marks.filter('ls -la\r\nfile a\r\nfile b\r\n\x1b]77')).toBe(
      'ls -la\r\nfile a\r\nfile b\r\n'
    );
    expect(marks.filter(`77;2\x07/ $ `)).toBe('/ $ ');
    expect(await result).toEqual({ stdout: 'file a\nfile b\n', stderr: '', exitCode: 2 });
    expect(marks.pending).toBe(false);
  });

  it('ends a pending capture when the shell goes away', async () => {
    const marks = new LoginShellMarks();
    marks.filter(mark(0));
    const result = marks.expect();
    marks.filter('exit\r\nlogout\r\n');
    marks.end();
    expect(await result).toEqual({ stdout: 'logout\n', stderr: '', exitCode: 1 });
    expect(marks.seen).toBe(false);
  });
});
