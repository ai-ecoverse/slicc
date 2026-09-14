import {
  type Arrangement,
  type LayoutDocument,
  type LayoutEnvironment,
  variantMatches,
} from './layout-schema.js';

export function liveArrangement(doc: LayoutDocument, env: LayoutEnvironment): Arrangement {
  let owner: Arrangement = doc.base;
  for (const variant of doc.variants ?? []) {
    if (!variantMatches(variant.when, env)) continue;
    if (variant.zones !== undefined || variant.center !== undefined) owner = variant;
  }
  return owner;
}
