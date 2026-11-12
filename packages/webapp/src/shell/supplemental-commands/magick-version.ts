/**
 * Bundled `@imagemagick/magick-wasm` version string, on its own so
 * boot-critical modules that only need the install-guidance pin
 * (`builtin-shadow-map.ts`) do not hoist `magick-wasm.ts` — and with it
 * the statically-imported ImageMagick JS glue — into the kernel worker's
 * eager first-load graph. Same leaf-constant pattern as
 * `base/gelatiere-constants.ts`.
 *
 * Baked from `packages/webapp/package.json` via the Vite / vitest
 * `__MAGICK_WASM_VERSION__` define (range-prefix stripped). Renovate
 * bumping the dependency updates the pin with no source literal to drift.
 */

export const BUNDLED_MAGICK_VERSION = __MAGICK_WASM_VERSION__;
