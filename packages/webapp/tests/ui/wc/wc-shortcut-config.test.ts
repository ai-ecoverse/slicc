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
  isUntouchedV1Document,
  loadShortcutConfig,
  parseKeymapDocument,
  SHORTCUT_KEYS_PATH,
  writeShortcutTrigger,
} from '../../../src/ui/wc/wc-shortcut-config.js';
import { COMMAND_IDS, DEFAULT_KEYMAP, V1_KEYMAP } from '../../../src/ui/wc/wc-shortcuts.js';

const doc = (bindings: unknown) => JSON.stringify({ bindings });

describe('parseKeymapDocument', () => {
  it('applies the file over the defaults, keeping what it does not mention', () => {
    const { keymap, warnings } = parseKeymapDocument(doc({ q: 'terminal' }));
    expect(keymap.q).toBe('terminal');
    // `t` is still Terminal too — the file adds a key, it does not move one.
    expect(keymap.t).toBe('terminal');
    expect(keymap['[']).toBe('leftRail');
    expect(warnings).toEqual([]);
  });

  it('unbinds on null, false or empty string', () => {
    for (const nothing of [null, false, '']) {
      const { keymap, warnings } = parseKeymapDocument(doc({ f: nothing }));
      expect(keymap.f).toBeUndefined();
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
   * The shipped file binds NOTHING, on purpose: v1 wrote its whole keymap out
   * and thereby pinned every install to it forever (see
   * {@link isUntouchedV1Document}). An override file that overrides nothing is
   * what makes the shipped map reachable — and keeps it reachable the next
   * time it changes.
   */
  it('the shipped /etc/slicc/keys.json binds nothing at all', async () => {
    const shipped = (await import('../../../../vfs-root/etc/slicc/keys.json?raw')).default;
    const { keymap, warnings, trigger } = parseKeymapDocument(shipped);
    expect(warnings).toEqual([]);
    expect(keymap).toEqual(DEFAULT_KEYMAP);
    expect(JSON.parse(shipped).bindings).toEqual({});
    expect(trigger).toBe('auto');
  });

  it('parses trigger null / esc / auto and warns on junk', () => {
    expect(parseKeymapDocument('{"trigger":null,"bindings":{}}').trigger).toBeNull();
    expect(parseKeymapDocument('{"trigger":"esc","bindings":{}}').trigger).toBe('esc');
    expect(parseKeymapDocument('{"trigger":"auto","bindings":{}}').trigger).toBe('auto');
    const bad = parseKeymapDocument('{"trigger":"vim","bindings":{}}');
    expect(bad.trigger).toBe('auto');
    expect(bad.warnings[0]).toContain('trigger');
  });

  /**
   * The comment tells users they can paste the v1 keymap back to restore the
   * old keyboard. That instruction is only true if the block is valid JSON —
   * a stray note between two property lines silently turns it into a document
   * `parseKeymapDocument` throws away, and the advertised procedure quietly
   * stops working.
   */
  it('the v1 paste-back block in the comment is a keymap that actually parses', async () => {
    const shipped = (await import('../../../../vfs-root/etc/slicc/keys.json?raw')).default;
    const lines = JSON.parse(shipped)['//'] as string[];
    const start = lines.findIndex((line) => line.trim().startsWith('"bindings"'));
    const end = lines.findIndex((line, i) => i > start && line.trim() === '}');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const { keymap, warnings } = parseKeymapDocument(
      `{${lines.slice(start, end + 1).join('\n')}}`,
      {}
    );
    expect(warnings).toEqual([]);
    // It restores the v1 keyboard, not some subset of it that still parses.
    expect(keymap.d).toBe('nextAgent');
    expect(Object.keys(keymap).length).toBeGreaterThanOrEqual(14);
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
    expect(JSON.parse(body).bindings).toEqual({});
    expect(JSON.parse(body).trigger).toBe('auto');
    // The seed IS the defaults, so there is nothing to apply.
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('applies a keymap it can read, and never rewrites the file', async () => {
    const h = harness({ file: doc({ q: 'terminal' }) });
    await h.run();
    expect(h.writer.writeFile).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledTimes(1);
    const applied = (
      h.apply.mock.calls[0] as unknown as [
        { keymap: Record<string, string>; trigger: string | null },
      ]
    )[0];
    expect(applied.keymap.q).toBe('terminal');
    expect(applied.trigger).toBe('auto');
  });

  it('applies an explicit trigger from the file', async () => {
    const h = harness({
      file: JSON.stringify({ trigger: 'esc', bindings: { q: 'terminal' } }),
    });
    await h.run();
    const applied = (
      h.apply.mock.calls[0] as unknown as [
        { keymap: Record<string, string>; trigger: string | null },
      ]
    )[0];
    expect(applied.trigger).toBe('esc');
    expect(applied.keymap.q).toBe('terminal');
  });

  it('applies trigger null to disable keyboard mode', async () => {
    const h = harness({ file: JSON.stringify({ trigger: null, bindings: {} }) });
    await h.run();
    expect(
      (h.apply.mock.calls[0] as unknown as [{ trigger: string | null }])[0].trigger
    ).toBeNull();
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

describe('the v1 keymap', () => {
  const v1Doc = JSON.stringify({ '//': ['old comment'], bindings: V1_KEYMAP });

  it('is recognised only when every entry still matches', () => {
    expect(isUntouchedV1Document(v1Doc)).toBe(true);
    // The three shapes an edit takes, each of which makes it somebody's file.
    expect(isUntouchedV1Document(JSON.stringify({ bindings: { ...V1_KEYMAP, q: 'help' } }))).toBe(
      false
    );
    const { d: _dropped, ...withoutD } = V1_KEYMAP;
    expect(isUntouchedV1Document(JSON.stringify({ bindings: withoutD }))).toBe(false);
    expect(
      isUntouchedV1Document(JSON.stringify({ bindings: { ...V1_KEYMAP, d: 'terminal' } }))
    ).toBe(false);
  });

  it('is not recognised in a file that is not a keymap at all', () => {
    expect(isUntouchedV1Document('{ not json')).toBe(false);
    expect(isUntouchedV1Document('{}')).toBe(false);
    expect(isUntouchedV1Document('{"bindings": []}')).toBe(false);
  });

  /**
   * The whole point of the migration: v1 seeded its map explicitly, so an
   * install that never edited the file would otherwise keep the v1 keyboard —
   * and every command added since — out of reach, forever.
   */
  it('is replaced once by the shipped document, leaving the user on the defaults', async () => {
    const h = harness({ file: v1Doc });
    await h.run();
    const [path, body] = h.writer.writeFile.mock.calls[0] as unknown as [string, string];
    expect(path).toBe(SHORTCUT_KEYS_PATH);
    expect(JSON.parse(body).bindings).toEqual({});
    // Nothing to apply: what was written IS "follow the shipped map".
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(expect.stringContaining('v1 keymap'));
  });

  it('keeps working on a filesystem that refuses the write', async () => {
    const h = harness({ file: v1Doc, writeFails: true });
    await h.run();
    // The v1 keys are still applied rather than lost — a failed migration
    // must never cost the user the keyboard they had.
    const applied = (h.apply.mock.calls[0] as unknown as [{ keymap: Record<string, string> }])[0];
    expect(applied.keymap.d).toBe('nextAgent');
    expect(h.warn).toHaveBeenCalledWith(
      'Could not replace the v1 shortcut config; keeping it',
      expect.anything()
    );
  });

  it('leaves an edited file alone, even one that started as v1', async () => {
    const h = harness({ file: JSON.stringify({ bindings: { ...V1_KEYMAP, q: 'help' } }) });
    await h.run();
    expect(h.writer.writeFile).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledTimes(1);
  });
});

describe('writeShortcutTrigger', () => {
  it('patches trigger while preserving custom bindings and comments', async () => {
    const existing = JSON.stringify({
      '//': ['mine'],
      trigger: 'auto',
      bindings: { q: 'terminal' },
    });
    const h = harness({ file: existing });
    await writeShortcutTrigger({ reader: h.reader as never, writer: h.writer as never }, 'esc');
    expect(h.writer.writeFile).toHaveBeenCalledTimes(1);
    const [, body] = h.writer.writeFile.mock.calls[0] as unknown as [string, string];
    const written = JSON.parse(body) as {
      '//': string[];
      trigger: string;
      bindings: Record<string, string>;
    };
    expect(written.trigger).toBe('esc');
    expect(written.bindings).toEqual({ q: 'terminal' });
    expect(written['//']).toEqual(['mine']);
  });

  it('refuses to replace a malformed file', async () => {
    const h = harness({ file: '{ not json' });
    await expect(
      writeShortcutTrigger({ reader: h.reader as never, writer: h.writer as never }, null)
    ).rejects.toThrow(/not valid JSON/);
    expect(h.writer.writeFile).not.toHaveBeenCalled();
  });

  it('refuses a non-object JSON root', async () => {
    const h = harness({ file: '[]' });
    await expect(
      writeShortcutTrigger({ reader: h.reader as never, writer: h.writer as never }, 'auto')
    ).rejects.toThrow(/must be a JSON object/);
    expect(h.writer.writeFile).not.toHaveBeenCalled();
  });
});
