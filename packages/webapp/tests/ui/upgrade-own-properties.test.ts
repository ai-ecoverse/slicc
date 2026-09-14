// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { upgradeOwnProperties } from '../../src/ui/upgrade-own-properties.js';

class Probe extends HTMLElement {
  seen: string[] = [];
  private _patch: string | null = null;

  get patch(): string | null {
    return this._patch;
  }

  set patch(value: string | null) {
    this._patch = value;
    this.seen.push(value ?? '<null>');
  }
}
customElements.define('probe-el', Probe);

function withPreUpgradeValue(value: unknown): Probe {
  const el = new Probe();
  Object.defineProperty(el, 'patch', {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return el;
}

describe('upgradeOwnProperties', () => {
  it('re-runs the accessor for a property set before the definition loaded', () => {
    const el = withPreUpgradeValue('--- a\n+++ b\n');

    upgradeOwnProperties(el, ['patch']);

    expect(el.seen).toEqual(['--- a\n+++ b\n']);
    expect(el.patch).toBe('--- a\n+++ b\n');
    expect(Object.hasOwn(el, 'patch')).toBe(false);
  });

  it('leaves untouched properties alone', () => {
    const el = new Probe();

    upgradeOwnProperties(el, ['patch']);

    expect(el.seen).toEqual([]);
    expect(el.patch).toBeNull();
  });

  it('adopts a pre-upgrade null without skipping it', () => {
    const el = withPreUpgradeValue(null);

    upgradeOwnProperties(el, ['patch']);

    expect(el.seen).toEqual(['<null>']);
  });

  it('ignores names the element never received', () => {
    const el = withPreUpgradeValue('x');

    expect(() => upgradeOwnProperties(el, ['patch', 'oldFile', 'newFile'])).not.toThrow();
    expect(el.seen).toEqual(['x']);
  });
});
