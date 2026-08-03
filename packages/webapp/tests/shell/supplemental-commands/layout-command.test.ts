import { describe, expect, it } from 'vitest';
import { parseLayoutArgs } from '../../../src/shell/supplemental-commands/layout-command.js';
import { LAYOUT_PRESETS } from '../../../src/ui/wc/layout-spec.js';

describe('parseLayoutArgs', () => {
  it('set <preset> resolves to the preset tree', () => {
    const r = parseLayoutArgs(['set', 'dashboard']);
    expect(r).toEqual({ kind: 'set', tree: LAYOUT_PRESETS.dashboard.tree });
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
