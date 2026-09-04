// @vitest-environment jsdom
/**
 * The session usage log: what the user actually does, counted off the
 * SURFACES' own events so a click counts exactly as much as the key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShortcutUsage } from '../../../src/ui/wc/wc-shortcut-usage.js';

function dockSelect(id: string): void {
  document.body.dispatchEvent(
    new CustomEvent('slicc-dock-select', { detail: { id }, bubbles: true, composed: true })
  );
}

describe('wc-shortcut-usage', () => {
  let usage: ReturnType<typeof createShortcutUsage>;

  beforeEach(() => {
    document.body.replaceChildren();
    usage = createShortcutUsage(document);
  });

  afterEach(() => usage.dispose());

  it('starts empty, so a first-run sheet shows no personalised section', () => {
    expect(usage.ranked()).toEqual([]);
    expect(usage.used('files')).toBe(false);
  });

  it('counts a keyed command', () => {
    usage.record('files');
    usage.record('files');
    expect(usage.used('files')).toBe(true);
    expect(usage.ranked()).toEqual([{ id: 'files', count: 2 }]);
  });

  /**
   * The whole point: a list of shortcuts you already use is worthless. The
   * sheet has to learn from the surfaces you reach for with the MOUSE.
   */
  it('counts a click on a rail item as the same action as its key', () => {
    dockSelect('files');
    dockSelect('files');
    usage.record('files');
    expect(usage.ranked()).toEqual([{ id: 'files', count: 3 }]);
  });

  it('maps every dock surface back to the command that opens it', () => {
    dockSelect('browser');
    dockSelect('term');
    dockSelect('memory');
    dockSelect('monitor');
    expect(
      usage
        .ranked()
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['memory', 'monitor', 'tabs', 'terminal']);
  });

  /** A sprinkle launcher has no fixed id; `sprinkles` is what opens one. */
  it('counts an unnamed launcher as a sprinkle', () => {
    dockSelect('sprinkle-hello');
    expect(usage.ranked()).toEqual([{ id: 'sprinkles', count: 1 }]);
  });

  it('counts the left rail toggle, however it was toggled', () => {
    document.body.dispatchEvent(new CustomEvent('freezer-toggle', { bubbles: true }));
    expect(usage.used('leftRail')).toBe(true);
  });

  it('ranks by count, breaking ties on what was done most recently', () => {
    usage.record('files');
    usage.record('files');
    usage.record('memory');
    usage.record('terminal');
    expect(usage.ranked()).toEqual([
      { id: 'files', count: 2 },
      { id: 'terminal', count: 1 },
      { id: 'memory', count: 1 },
    ]);
  });

  it('ignores a select with no usable id', () => {
    document.body.dispatchEvent(
      new CustomEvent('slicc-dock-select', { detail: {}, bubbles: true, composed: true })
    );
    expect(usage.ranked()).toEqual([]);
  });

  it('stops counting once disposed', () => {
    usage.dispose();
    dockSelect('files');
    expect(usage.ranked()).toEqual([]);
  });
});
