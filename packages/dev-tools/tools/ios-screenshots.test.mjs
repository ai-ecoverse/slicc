// Pins the pure logic of the iOS PR screenshots job: registry validation
// (a bad edit fails legibly), version-sorted simulator selection (dict order
// is unspecified and older runtimes fail at launch), and the manifest shape
// the workflow's upload + comment steps rely on. The live registry is also
// validated so a malformed screen entry fails here before it fails on a
// macOS runner.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  pickNewestIPhone,
  screenshotFile,
  validateScreens,
} from './ios-screenshots-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('validateScreens', () => {
  it('accepts the live registry', () => {
    const registry = JSON.parse(
      readFileSync(resolve(here, '../../ios-app/screenshot-screens.json'), 'utf8')
    );
    const screens = validateScreens(registry);
    expect(screens.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects duplicates, bad names, and bad args in one report', () => {
    const registry = {
      screens: [
        { name: 'ok', args: ['-a'] },
        { name: 'ok', args: ['-a'] },
        { name: 'Bad Name', args: ['-a'] },
        { name: 'no-args', args: [] },
        { name: 'bad-settle', args: ['-a'], settleSeconds: 0 },
      ],
    };
    expect(() => validateScreens(registry)).toThrowError(/duplicate name "ok"/);
    expect(() => validateScreens(registry)).toThrowError(/kebab-case/);
    expect(() => validateScreens(registry)).toThrowError(/non-empty array of strings/);
    expect(() => validateScreens(registry)).toThrowError(/settleSeconds/);
  });

  it('rejects an empty registry', () => {
    expect(() => validateScreens({ screens: [] })).toThrowError(/non-empty/);
  });
});

describe('pickNewestIPhone', () => {
  const sim = (runtime, devices) => ({
    [`com.apple.CoreSimulator.SimRuntime.${runtime}`]: devices,
  });

  it('picks an iPhone from the newest iOS runtime, not dict order', () => {
    const json = {
      devices: {
        ...sim('iOS-26-4', [{ isAvailable: true, name: 'iPhone 17', udid: 'old' }]),
        ...sim('iOS-18-5', [{ isAvailable: true, name: 'iPhone 16', udid: 'older' }]),
        ...sim('iOS-26-5', [{ isAvailable: true, name: 'iPhone 17 Pro', udid: 'newest' }]),
      },
    };
    expect(pickNewestIPhone(json)).toBe('newest');
  });

  it('skips runtimes with no available iPhone and non-iOS runtimes', () => {
    const json = {
      devices: {
        ...sim('iOS-26-5', [{ isAvailable: false, name: 'iPhone 17 Pro', udid: 'na' }]),
        ...sim('watchOS-12-0', [{ isAvailable: true, name: 'Apple Watch', udid: 'watch' }]),
        ...sim('iOS-18-5', [{ isAvailable: true, name: 'iPhone 16', udid: 'fallback' }]),
      },
    };
    expect(pickNewestIPhone(json)).toBe('fallback');
  });

  it('returns null when nothing qualifies', () => {
    expect(pickNewestIPhone({ devices: {} })).toBeNull();
  });
});

describe('buildManifest', () => {
  const screens = [
    { name: 'settings', args: ['-a'] },
    { name: 'frozen-list', args: ['-b'] },
  ];

  it('emits the storybook-compatible shot shape', () => {
    const manifest = buildManifest(
      screens,
      { settings: 'aa', 'frozen-list': 'bb' },
      { device: 'iPhone 17 Pro' }
    );
    expect(manifest.device).toBe('iPhone 17 Pro');
    expect(manifest.shots).toEqual([
      { file: 'ios-settings.png', contentHash: 'aa', storyId: 'settings', theme: 'ios' },
      { file: 'ios-frozen-list.png', contentHash: 'bb', storyId: 'frozen-list', theme: 'ios' },
    ]);
  });

  it('fails loudly on a screen with no captured hash', () => {
    expect(() => buildManifest(screens, { settings: 'aa' }, { device: 'x' })).toThrowError(
      /frozen-list/
    );
  });

  it('filenames are namespaced so they cannot collide with storybook shots', () => {
    expect(screenshotFile('settings')).toBe('ios-settings.png');
  });
});
