/**
 * @zenfs/core 2.9.0 stores directory listings as a packed `DirListing`
 * header plus variable-length `DirEntry`s. Upstream wrote:
 *
 *   class DirListing extends struct.packed('DirListing', …) { … }
 *   sizeof(DirListing)  // in scan() / from()
 *
 * memium's `sizeof` / `isType` key the type registry by `type.name`. The
 * anonymous packed base is registered as `'DirListing'`, but the subclass's
 * `.name` is the class-declaration name. Production kernel-worker bundles
 * minify that to `class e`, so `typeRegistry.has('e')` is false,
 * `sizeof(DirListing)` throws `Unable to resolve size of …`, StoreFS cannot
 * create the root / empty dirs, the kernel worker boot fails, and the UI
 * stays on "Restoring session…". Vitest does not minify, so unit tests
 * alone never saw it — only Playwright e2e against the built worker.
 *
 * The patch splits the packed header into `DirListingHeader` and sizes
 * via `dirListingHeaderSize` (never `sizeof` the subclass).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const storeFsPath = resolve(repoRoot, 'node_modules/@zenfs/core/dist/backends/store/fs.js');
/** Resolve through the filesystem so knip does not treat memium as an unlisted dep. */
const memiumUrl = pathToFileURL(resolve(repoRoot, 'node_modules/memium/dist/index.js')).href;

describe('@zenfs/core DirListing sizeof under minify (#4261)', () => {
  it('the installed dist sizes the packed header, not the subclass', () => {
    const src = readFileSync(storeFsPath, 'utf8');
    expect(
      src.includes('const DirListingHeader = struct.packed'),
      'Installed @zenfs/core no longer splits DirListingHeader from the ' +
        'DirListing subclass — patches/@zenfs+core+*.patch is missing or ' +
        'failed to apply. Minified kernel-worker bundles will throw ' +
        '"Unable to resolve size of … DirListing" during StoreFS boot.'
    ).toBe(true);
    expect(src.includes('dirListingHeaderSize')).toBe(true);
    // Strip block comments so the explanatory note about the old
    // `sizeof(DirListing)` call does not trip the pin.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(
      /sizeof\(\s*DirListing\s*\)/.test(code),
      'Installed @zenfs/core still calls sizeof(DirListing) on the ' +
        'subclass. That path breaks once the class declaration is minified.'
    ).toBe(false);
  });

  it('reproduces the memium failure a minifier triggers, and the header workaround', async () => {
    const { sizeof, struct, types: t } = await import(/* @vite-ignore */ memiumUrl);
    const Header = struct.packed(
      'DirListingMinifyRepro',
      { magic: t.uint8, entry_count: t.uint32 },
      { fastFields: true }
    );
    const Subclass = class extends Header {
      get size() {
        return this.entry_count;
      }
    };
    Object.defineProperty(Subclass, 'name', { value: 'e' });

    expect(() => sizeof(Subclass)).toThrow(/Unable to resolve size/);
    // Same shape as the patch: size the registered packed base, not the subclass.
    expect(sizeof(Header)).toBe(5);
    expect(Header.size).toBe(5);
  });
});
