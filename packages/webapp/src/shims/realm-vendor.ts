/**
 * `realm-vendor.ts` — the pure-JS hash + compression libraries that the
 * realm's `crypto.createHash` and `zlib` shims depend on, published on
 * `globalThis.__sliccRealmVendor` for the CSP-isolated `sandbox.html` iframe
 * float. That iframe runs outside the TS module graph and cannot `import`, so
 * the chrome-extension Vite build bundles this module as a standalone IIFE
 * (`realm-vendor.js`) loaded via `<script src="realm-vendor.js">` before the
 * realm bootstrap executes. The standalone worker float imports the same
 * libraries directly in `js-realm-helpers.ts`, so this shim is the iframe-float
 * parity twin (mirrors `buffer-polyfill.ts`).
 */

import { md5 } from 'js-md5';
import { sha1 } from 'js-sha1';
import { sha256 } from 'js-sha256';
import * as pako from 'pako';

const g = globalThis as Record<string, unknown>;
if (!g['__sliccRealmVendor']) {
  g['__sliccRealmVendor'] = { md5, sha1, sha256, pako };
}
