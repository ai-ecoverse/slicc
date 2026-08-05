/**
 * Which arrangement in a document the current environment actually renders.
 *
 * DOM-free so it can be unit-tested and imported by the webapp's kernel-worker-side
 * layout code, which has no DOM.
 *
 * This is the whole module now: it once held the algebra for a recursive center
 * split tree (move/insert/remove a leaf, weights per split), which the five-zone
 * model replaced with plain list operations in `layout-schema.ts`.
 */

import {
  type Arrangement,
  type LayoutDocument,
  type LayoutEnvironment,
  variantMatches,
} from './layout-schema.js';

/**
 * The section of `doc` that owns the working area in `env`.
 *
 * Variants REPLACE the working area (see `resolveLayout`), so the last matching
 * variant that supplies one is what the user is looking at — and therefore what
 * their drag must edit. Rearranging while a narrow variant is active edits that
 * variant, leaving the wide arrangement alone; without this the edit would land on
 * `base` and appear to do nothing.
 */
export function liveArrangement(doc: LayoutDocument, env: LayoutEnvironment): Arrangement {
  let owner: Arrangement = doc.base;
  for (const variant of doc.variants ?? []) {
    if (!variantMatches(variant.when, env)) continue;
    if (variant.zones !== undefined || variant.center !== undefined) owner = variant;
  }
  return owner;
}
