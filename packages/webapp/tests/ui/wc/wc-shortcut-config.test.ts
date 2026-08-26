// @vitest-environment jsdom
/**
 * `/etc/slicc/keys.json`: merging a user keymap over the shipped defaults,
 * and the seed-once-then-never-write load policy.
 *
 * The bias under test throughout is "never lose the keyboard": every bad input
 * degrades to the defaults for the entry it broke, and to nothing worse.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  loadShortcutConfig,
  parseKeymapDocument,
  SHORTCUT_KEYS_PATH,
} from '../../../src/ui/wc/wc-shortcut-config.js';
import { COMMAND_IDS, DEFAULT_KEYMAP } from '../../../src/ui/wc/wc-shortcuts.js';

const doc = (bindings: unknown) => JSON.stringify({ bindings });

describe('parseKeymapDocument', () => {
  it('applies the file over the defaults, keeping what it does not mention', () => {
    const { keymap, warnings } = parseKeymapDocument(doc({ q: 'terminal' }));
    expect(keymap.q).toBe('terminal');
    // `e` is still Terminal too — the file adds a key, it does not move one.
    expect(keymap.e).toBe('terminal');
    expect(keymap.b).toBe('leftRail');
    expect(warnings).toEqual([]);
  });

  it('unbinds on null, false or empty string', () => {
    for (const nothing of [null, false, '']) {
      const { keymap, warnings } = parseKeymapDocument(doc({ b: nothing }));
      expect(keymap.b).toBeUndefined();
      expect(warnings).toEqual([]);
    }
  });

  it('names an unknown command instead of taking it', () => {
    const { keymap, warnings } = parseKeymapDocument(doc({ q: 'launchTheMissiles' }));
    expect(keymap.q).toBeUndefined();
    expect(warnings).toEqual(['"q": "launchTheMissiles" is not a known command']);
  });

  it('refuses the keys that are the mode itself', () => {
    const { keymap, warnings } = parseKeymapDocument(doc({ Escape: 'help', '3': 'terminal' }));
    expect(keymap.Escape).toBeUndefined();
    expect(keymap['3']).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('reserved');
  });

  it('refuses a key no keypress could ever produce', () => {
    const { warnings } = parseKeymapDocument(doc({ 'ctrl-shift-q': 'help' }));
    expect(warnings[0]).toContain('not a key SLICC can bind');
  });

  it('takes a named key it knows', () => {
    expect(parseKeymapDocument(doc({ Tab: 'nextAgent' })).keymap.Tab).toBe('nextAgent');
  });

  it('keeps one bad line from costing the good ones', () => {
    const { keymap, warnings } = parseKeymapDocument(
      doc({ q: 'nope', w: 'terminal', Escape: 'help' })
    );
    expect(keymap.w).toBe('terminal');
    expect(warnings).toHaveLength(2);
  });

  it('survives JSON that is not JSON', () => {
    const { keymap, warnings } = parseKeymapDocument('{ this is not json');
    expect(keymap).toEqual(DEFAULT_KEYMAP);
    expect(warnings[0]).toContain('not valid JSON');
  });

  it.each([
    ['{}', 'no "bindings" object'],
    ['{"bindings": []}', 'not an object'],
    ['{"bindings": "x"}', 'not an object'],
    ['null', 'no "bindings" object'],
  ])('survives %s', (text, expected) => {
    const { keymap, warnings } = parseKeymapDocument(text);
    expect(keymap).toEqual(DEFAULT_KEYMAP);
    expect(warnings[0]).toContain(expected);
  });

  /**
   * The shipped file and the in-code defaults are two statements of the same
   * thing; this is what stops them drifting. If it fails, one of them changed
   * alone.
   */
  it('the shipped /etc/slicc/keys.json IS the default keymap', async () => {
    const shipped = (await import('../../../../vfs-root/etc/slicc/keys.json?raw')).default;
    const { keymap, warnings } = parseKeymapDocument(shipped, {});
    expect(warnings).toEqual([]);
    expect(keymap).toEqual(DEFAULT_KEYMAP);
  });

  it('the shipped file documents every command that exists', async () => {
    const shipped = (await import('../../../../vfs-root/etc/slicc/keys.json?raw')).default;
    const help = (JSON.parse(shipped)['//'] as string[]).join(' ');
    for (const id of COMMAND_IDS) expect(help).toContain(id);
  });
});

/** The VFS RPC rejects with an `FsError`-shaped error carrying a code. */
function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: /etc/slicc/keys.json`), { code });
}

function harness(options: { file?: string; readError?: string; writeFails?: boolean } = {}) {
  const apply = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const writeFile = vi.fn(async () => {
    if (options.writeFails) throw new Error('read-only');
  });
  const reader = {
    readFile: vi.fn(async () => {
      if (options.readError) throw fsError(options.readError);
      if (options.file === undefined) throw fsError('ENOENT');
      return options.file;
    }),
  };
  const writer = { writeFile, mkdir: vi.fn(async () => undefined) };
  return {
    apply,
    warn,
    info,
    reader,
    writer,
    run: () =>
      loadShortcutConfig({
        reader: reader as never,
        writer: writer as never,
        apply,
        logger: { info, warn },
      }),
  };
}

describe('loadShortcutConfig', () => {
  it('seeds the shipped file when there is none, and stays on defaults', async () => {
    const h = harness();
    await h.run();
    expect(h.writer.mkdir).toHaveBeenCalledWith('/etc/slicc', { recursive: true });
    const [path, body] = h.writer.writeFile.mock.calls[0] as unknown as [string, string];
    expect(path).toBe(SHORTCUT_KEYS_PATH);
    expect(JSON.parse(body).bindings.x).toBe('rightRail');
    // The seed IS the defaults, so there is nothing to apply.
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('applies a keymap it can read, and never rewrites the file', async () => {
    const h = harness({ file: doc({ q: 'terminal' }) });
    await h.run();
    expect(h.writer.writeFile).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect((h.apply.mock.calls[0] as unknown as [Record<string, string>])[0].q).toBe('terminal');
  });

  it('reports what it ignored, on the line the user can fix', async () => {
    const h = harness({ file: doc({ q: 'nope' }) });
    await h.run();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('not a known command'));
    // Still applied: the rest of the file is good.
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug this exists to prevent: an early read (before the worker's VFS
   * host attaches) fails with EIO, and an earlier version treated ANY read
   * failure as "no file yet" and re-seeded — silently reverting the user's
   * edits on the next boot.
   */
  it('never overwrites a config it merely failed to read', async () => {
    for (const code of ['EIO', 'EBADF', 'EACCES']) {
      const h = harness({ readError: code });
      await h.run();
      expect(h.writer.writeFile).not.toHaveBeenCalled();
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.warn).toHaveBeenCalledWith(
        'Could not read the shortcut config; keeping the defaults',
        expect.anything()
      );
    }
  });

  it('seeds only on ENOENT', async () => {
    const h = harness({ readError: 'ENOENT' });
    await h.run();
    expect(h.writer.writeFile).toHaveBeenCalledTimes(1);
  });

  it('a filesystem that will not take the seed is not an error the user sees', async () => {
    const h = harness({ writeFails: true });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.warn).toHaveBeenCalledWith(
      'Could not seed the shortcut config',
      expect.objectContaining({ error: 'read-only' })
    );
    expect(h.apply).not.toHaveBeenCalled();
  });
});
