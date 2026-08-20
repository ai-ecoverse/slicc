import { describe, expect, it } from 'vitest';
import {
  createLayoutCommand,
  parseLayoutArgs,
} from '../../../src/shell/supplemental-commands/layout-command.js';
import { LAYOUT_PRESETS } from '../../../src/ui/wc/layout-spec.js';

describe('parseLayoutArgs', () => {
  it('set <preset> resolves to the preset tree', () => {
    const r = parseLayoutArgs(['set', 'focus']);
    expect(r).toEqual({ kind: 'set', tree: LAYOUT_PRESETS.focus.tree });
  });

  it('unknown preset is an error', () => {
    const r = parseLayoutArgs(['set', 'bogus']);
    expect('error' in r && r.error).toMatch(/unknown layout/i);
  });

  it('chat <zone> moves the chat leaf', () => {
    expect(parseLayoutArgs(['chat', 'right'])).toEqual({ kind: 'chat', zone: 'right' });
  });

  it('chat with an invalid zone is an error', () => {
    const r = parseLayoutArgs(['chat', 'nope']);
    expect('error' in r && r.error).toMatch(/usage: layout chat/i);
  });

  it('reset returns a reset action', () => {
    expect(parseLayoutArgs(['reset'])).toEqual({ kind: 'reset' });
  });

  it('edit is a friendly alias for set focus (the dock-tree is always active)', () => {
    expect(parseLayoutArgs(['edit'])).toEqual({ kind: 'set', tree: LAYOUT_PRESETS.focus.tree });
  });

  it('empty / unknown subcommand is an error', () => {
    expect('error' in parseLayoutArgs([])).toBe(true);
    expect('error' in parseLayoutArgs(['wat'])).toBe(true);
  });

  describe('open/close/move (surfaceId normalization)', () => {
    it('open <surfaceId> <zone> normalizes a bare name to a sprinkle surfaceId', () => {
      expect(parseLayoutArgs(['open', 'weather', 'right'])).toEqual({
        kind: 'open',
        surfaceId: 'sprinkle:weather',
        zone: 'right',
      });
    });

    it('open passes chat and tool-panel ids through unchanged', () => {
      expect(parseLayoutArgs(['open', 'chat', 'left'])).toEqual({
        kind: 'open',
        surfaceId: 'chat',
        zone: 'left',
      });
      expect(parseLayoutArgs(['open', 'files', 'right'])).toEqual({
        kind: 'open',
        surfaceId: 'files',
        zone: 'right',
      });
    });

    it('open passes an already-prefixed surfaceId through unchanged', () => {
      expect(parseLayoutArgs(['open', 'sprinkle:weather', 'top'])).toEqual({
        kind: 'open',
        surfaceId: 'sprinkle:weather',
        zone: 'top',
      });
    });

    it('open requires a valid zone', () => {
      const r = parseLayoutArgs(['open', 'weather', 'nope']);
      expect('error' in r && r.error).toMatch(/usage: layout open/i);
    });

    it('open requires a surfaceId', () => {
      const r = parseLayoutArgs(['open']);
      expect('error' in r && r.error).toMatch(/usage: layout open/i);
    });

    it('close <surfaceId> normalizes and requires a surfaceId', () => {
      expect(parseLayoutArgs(['close', 'weather'])).toEqual({
        kind: 'close',
        surfaceId: 'sprinkle:weather',
      });
      const r = parseLayoutArgs(['close']);
      expect('error' in r && r.error).toMatch(/usage: layout close/i);
    });

    it('move <surfaceId> <zone> generalizes chat <zone> to any surface', () => {
      expect(parseLayoutArgs(['move', 'chat', 'bottom'])).toEqual({
        kind: 'move',
        surfaceId: 'chat',
        zone: 'bottom',
      });
      expect(parseLayoutArgs(['move', 'weather', 'bottom'])).toEqual({
        kind: 'move',
        surfaceId: 'sprinkle:weather',
        zone: 'bottom',
      });
    });

    it('move requires a valid zone', () => {
      const r = parseLayoutArgs(['move', 'weather', 'nope']);
      expect('error' in r && r.error).toMatch(/usage: layout move/i);
    });
  });

  describe('layout-document verbs', () => {
    it('load takes a name (saved layout or preset — the page resolves which)', () => {
      expect(parseLayoutArgs(['load', 'my-dashboard'])).toEqual({
        kind: 'load',
        name: 'my-dashboard',
      });
      expect('error' in parseLayoutArgs(['load'])).toBe(true);
    });

    it('save defaults to the freely-writable root', () => {
      expect(parseLayoutArgs(['save', 'mine'])).toEqual({
        kind: 'save',
        name: 'mine',
        protected: false,
      });
    });

    it('save --protected targets the sudo-gated root', () => {
      expect(parseLayoutArgs(['save', 'pinned', '--protected'])).toEqual({
        kind: 'save',
        name: 'pinned',
        protected: true,
      });
    });

    it('save rejects a name that would escape the layouts directory', () => {
      // The name becomes a filename; a separator would write elsewhere entirely.
      for (const bad of ['../escape', 'a/b', '/etc/passwd', 'we ird']) {
        const r = parseLayoutArgs(['save', bad]);
        expect('error' in r && r.error).toMatch(/invalid layout name/i);
      }
    });

    it('save requires a name and rejects unknown flags', () => {
      expect('error' in parseLayoutArgs(['save'])).toBe(true);
      expect('error' in parseLayoutArgs(['save', '--protected'])).toBe(true);
      const r = parseLayoutArgs(['save', 'mine', '--force']);
      expect('error' in r && r.error).toMatch(/unknown flag/i);
    });

    it('delete takes a name', () => {
      expect(parseLayoutArgs(['delete', 'old'])).toEqual({ kind: 'delete', name: 'old' });
      expect('error' in parseLayoutArgs(['delete'])).toBe(true);
    });

    it('docs and panels take no arguments', () => {
      expect(parseLayoutArgs(['docs'])).toEqual({ kind: 'docs' });
      expect(parseLayoutArgs(['panels'])).toEqual({ kind: 'panels' });
    });

    it('show/hide normalize a bare sprinkle name like the other verbs', () => {
      expect(parseLayoutArgs(['show', 'weather'])).toEqual({
        kind: 'show',
        panelId: 'sprinkle:weather',
      });
      expect(parseLayoutArgs(['hide', 'files'])).toEqual({ kind: 'hide', panelId: 'files' });
      expect('error' in parseLayoutArgs(['show'])).toBe(true);
      expect('error' in parseLayoutArgs(['hide'])).toBe(true);
    });

    it('the usage line advertises the document verbs', () => {
      const r = parseLayoutArgs(['bogus']);
      expect('error' in r && r.error).toMatch(/load\|save\|delete\|docs\|panels/);
    });
  });

  describe('size (px/percent resize)', () => {
    it('parses --width and --height as bare pixel numbers', () => {
      expect(parseLayoutArgs(['size', 'weather', '--width', '300', '--height', '150px'])).toEqual({
        kind: 'size',
        surfaceId: 'sprinkle:weather',
        size: { widthPx: 300, heightPx: 150 },
      });
    });

    it('parses a % suffix as percent', () => {
      expect(parseLayoutArgs(['size', 'chat', '--width', '40%'])).toEqual({
        kind: 'size',
        surfaceId: 'chat',
        size: { widthPercent: 40 },
      });
    });

    it('requires a surfaceId', () => {
      const r = parseLayoutArgs(['size']);
      expect('error' in r && r.error).toMatch(/usage: layout size/i);
    });

    it('requires at least one of --width/--height', () => {
      const r = parseLayoutArgs(['size', 'weather']);
      expect('error' in r && r.error).toMatch(/usage: layout size/i);
    });

    it('rejects an unknown flag', () => {
      const r = parseLayoutArgs(['size', 'weather', '--depth', '10']);
      expect('error' in r && r.error).toMatch(/unknown flag/i);
    });

    it('rejects a flag with no value', () => {
      const r = parseLayoutArgs(['size', 'weather', '--width']);
      expect('error' in r && r.error).toMatch(/missing value/i);
    });

    it('rejects an invalid size token', () => {
      const r = parseLayoutArgs(['size', 'weather', '--width', 'huge']);
      expect('error' in r && r.error).toMatch(/invalid size/i);
    });
  });
});

describe('layout --help', () => {
  const run = (args: string[]) =>
    (createLayoutCommand() as any).execute(args, { cwd: '/', env: {}, fs: {} as any });

  it('prints usage for the bare command', async () => {
    const r = await run(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('usage: layout');
  });

  it('`reset --help` prints help instead of resetting the workbench', async () => {
    // Regression: `reset` and `edit` ignore their trailing args, so asking
    // them for help rearranged the user's panels. There is no panel-RPC
    // client in tests — a non-zero exit here would mean the verb ran.
    const r = await run(['reset', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('reset');
  });

  it('`edit --help` prints help instead of applying the default preset', async () => {
    const r = await run(['edit', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('edit');
  });
});
