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
  pickNewestIPad,
  pickNewestIPhone,
  screensForCapture,
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

describe('pickNewestIPad', () => {
  it('picks an available iPad from the newest iOS runtime', () => {
    const json = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
          { isAvailable: true, name: 'iPad Pro 13-inch', udid: 'older' },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { isAvailable: true, name: 'iPhone 17 Pro', udid: 'phone' },
          { isAvailable: true, name: 'iPad Air 13-inch', udid: 'newest' },
        ],
      },
    };
    expect(pickNewestIPad(json)).toBe('newest');
  });

  it('returns null when no iPad qualifies', () => {
    expect(pickNewestIPad({ devices: {} })).toBeNull();
  });

  it('skips unavailable iPads and non-iOS runtimes', () => {
    const json = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { isAvailable: false, name: 'iPad Pro 13-inch', udid: 'unavailable' },
        ],
        'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [
          { isAvailable: true, name: 'iPad impostor', udid: 'watch' },
        ],
      },
    };
    expect(pickNewestIPad(json)).toBeNull();
  });
});

describe('screensForCapture', () => {
  const screens = [
    { name: 'settings', args: ['-a'] },
    { name: 'conversation-fixture', args: ['-b'] },
  ];

  it('selects and namespaces the iPad proof screen', () => {
    expect(
      screensForCapture(screens, { device: 'ipad', screenName: 'conversation-fixture' })
    ).toEqual([{ name: 'ipad-conversation-fixture', args: ['-b'] }]);
  });

  it('leaves the complete iPhone registry names unchanged', () => {
    expect(screensForCapture(screens, { device: 'iphone' })).toEqual(screens);
  });

  it('rejects an unknown requested screen', () => {
    expect(() => screensForCapture(screens, { device: 'ipad', screenName: 'missing' })).toThrow(
      /not registered/
    );
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
