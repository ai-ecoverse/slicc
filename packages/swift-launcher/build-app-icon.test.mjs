import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIcns, buildIconAssetCatalog, findActool, ICNS_SIZES } from './build-app-icon.mjs';

describe('app icon assembly', () => {
  let root;
  let resourcesDir;
  let calls;

  /**
   * Fake `run` that records invocations and fabricates whatever output the
   * real tool would have written, so the helpers can be exercised without
   * Xcode, `sips` or `iconutil` on the machine running the test.
   */
  function fakeRun(overrides = {}) {
    return (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'xcrun' && args[0] === '--find') {
        if (overrides.actoolMissing) throw new Error('xcrun: unable to find utility "actool"');
        return '/Applications/Xcode.app/Contents/Developer/usr/bin/actool\n';
      }
      if (cmd === 'sips') {
        writeFileSync(args[args.indexOf('--out') + 1], 'png');
      }
      if (cmd === 'iconutil') {
        writeFileSync(args[args.indexOf('-o') + 1], 'icns');
      }
      if (cmd.endsWith('actool') && !overrides.actoolProducesNothing) {
        const out = args[args.indexOf('--compile') + 1];
        writeFileSync(resolve(out, 'Assets.car'), 'car');
        // actool always drops a same-named .icns beside the car.
        writeFileSync(resolve(out, 'macos-icon.icns'), 'icns');
        writeFileSync(args[args.indexOf('--output-partial-info-plist') + 1], '<plist/>');
      }
      return '';
    };
  }

  beforeEach(() => {
    calls = [];
    root = mkdtempSync(resolve(tmpdir(), 'slicc-appicon-'));
    resourcesDir = resolve(root, 'Contents/Resources');
    mkdirSync(resourcesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('buildIcns', () => {
    it('renders every iconset size and folds them into AppIcon.icns', () => {
      const iconSrc = resolve(root, 'src.png');
      writeFileSync(iconSrc, 'png');

      const icns = buildIcns({ iconSrc, resourcesDir, run: fakeRun() });

      expect(icns).toBe(resolve(resourcesDir, 'AppIcon.icns'));
      expect(calls.filter(([cmd]) => cmd === 'sips')).toHaveLength(ICNS_SIZES.length);
      // The staging iconset is scratch space; leaving it in Resources would
      // ship ~10 redundant PNGs inside the signed bundle.
      expect(existsSync(resolve(resourcesDir, 'AppIcon.iconset'))).toBe(false);
    });

    it('fails loudly when the source PNG is missing', () => {
      expect(() =>
        buildIcns({ iconSrc: resolve(root, 'nope.png'), resourcesDir, run: fakeRun() })
      ).toThrow(/Icon source not found/);
    });
  });

  describe('findActool', () => {
    it('returns null instead of throwing when Xcode is absent', () => {
      expect(findActool(fakeRun({ actoolMissing: true }))).toBeNull();
    });
  });

  describe('buildIconAssetCatalog', () => {
    let iconBundle;

    beforeEach(() => {
      iconBundle = resolve(root, 'macos-icon.icon');
      mkdirSync(resolve(iconBundle, 'Assets'), { recursive: true });
      writeFileSync(resolve(iconBundle, 'icon.json'), '{}');
    });

    it('compiles the .icon into Assets.car and reports the CFBundleIconName', () => {
      const result = buildIconAssetCatalog({
        iconBundle,
        resourcesDir,
        deploymentTarget: '26.0',
        run: fakeRun(),
      });

      expect(result).toEqual({ built: true, iconName: 'macos-icon' });
      expect(existsSync(resolve(resourcesDir, 'Assets.car'))).toBe(true);
    });

    it('targets macosx so actool emits Aqua/DarkAqua/Tintable stacks', () => {
      buildIconAssetCatalog({
        iconBundle,
        resourcesDir,
        deploymentTarget: '26.0',
        run: fakeRun(),
      });

      const actoolCall = calls.find(([cmd]) => cmd.endsWith('actool'));
      expect(actoolCall).toContain('--platform');
      expect(actoolCall[actoolCall.indexOf('--platform') + 1]).toBe('macosx');
      expect(actoolCall[actoolCall.indexOf('--minimum-deployment-target') + 1]).toBe('26.0');
    });

    it("removes actool's stray same-named .icns so AppIcon.icns stays the only one", () => {
      buildIconAssetCatalog({
        iconBundle,
        resourcesDir,
        deploymentTarget: '26.0',
        run: fakeRun(),
      });

      expect(existsSync(resolve(resourcesDir, 'macos-icon.icns'))).toBe(false);
    });

    it('leaves no partial Info.plist behind in the signed bundle', () => {
      buildIconAssetCatalog({
        iconBundle,
        resourcesDir,
        deploymentTarget: '26.0',
        run: fakeRun(),
      });

      expect(existsSync(resolve(resourcesDir, 'actool-partial.plist'))).toBe(false);
    });

    it('degrades instead of throwing when Xcode is not installed', () => {
      const result = buildIconAssetCatalog({
        iconBundle,
        resourcesDir,
        deploymentTarget: '26.0',
        run: fakeRun({ actoolMissing: true }),
      });

      expect(result.built).toBe(false);
      expect(result.skipped).toMatch(/actool not found/);
    });

    it('degrades when actool runs but emits no catalog', () => {
      const result = buildIconAssetCatalog({
        iconBundle,
        resourcesDir,
        deploymentTarget: '26.0',
        run: fakeRun({ actoolProducesNothing: true }),
      });

      expect(result.built).toBe(false);
      expect(result.skipped).toMatch(/no Assets.car/);
    });

    it('fails loudly when the .icon bundle is missing from the repo', () => {
      expect(() =>
        buildIconAssetCatalog({
          iconBundle: resolve(root, 'gone.icon'),
          resourcesDir,
          deploymentTarget: '26.0',
          run: fakeRun(),
        })
      ).toThrow(/Icon Composer bundle not found/);
    });
  });
});
