import { describe, expect, it } from 'vitest';
import { parseStartArgs } from '../../../../src/shell/supplemental-commands/jshd/parse-start.js';

const defaults = { cwd: '/workspace', env: new Map<string, string>() };

describe('parseStartArgs', () => {
  it('parses flags, repeatable --env, and trailing script args', () => {
    const parsed = parseStartArgs(
      [
        '-n',
        'phone',
        '--enable',
        '--restart',
        'on-failure',
        '--cwd',
        '/tmp',
        '--env',
        'A=1',
        '--env',
        'B=x=y',
        'adb.jsh',
        'computer',
        '--serial',
        'x',
      ],
      defaults
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toMatchObject({
      name: 'phone',
      enabled: true,
      restart: 'on-failure',
      cwd: '/tmp',
      env: { A: '1', B: 'x=y' },
      argv: ['adb.jsh', 'computer', '--serial', 'x'],
    });
  });

  it('defaults the unit name from the script basename', () => {
    const parsed = parseStartArgs(['./watch.jsh'], defaults);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.name).toBe('watch');
    expect(parsed.record.enabled).toBe(false);
    expect(parsed.record.restart).toBe('always');
  });

  it('rejects unknown flags, bad names, and missing scripts', () => {
    expect(parseStartArgs(['--nope', 'x.jsh'], defaults)).toEqual({
      ok: false,
      error: 'unknown flag: --nope',
    });
    expect(parseStartArgs(['-n', '../x', 'x.jsh'], defaults).ok).toBe(false);
    expect(parseStartArgs(['--enable'], defaults)).toEqual({
      ok: false,
      error: 'missing script.jsh or skill-command',
    });
    expect(parseStartArgs(['--restart', 'sometimes', 'x.jsh'], defaults).ok).toBe(false);
  });

  it('treats tokens after -- as the script even when they look like flags', () => {
    const parsed = parseStartArgs(['--', '--odd.jsh', 'a'], defaults);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.name).toBe('odd');
    expect(parsed.record.argv).toEqual(['--odd.jsh', 'a']);
  });
});
