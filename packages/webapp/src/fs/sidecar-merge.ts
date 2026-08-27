/**
 * `sidecar-merge.ts` — pure merge logic for the OPFS `/.metadata.json`
 * sidecar (the persisted ZenFS `WebAccessFS` index).
 *
 * Why this exists (#1992): the sidecar used to be written as a whole-file
 * snapshot of the calling context's in-memory index. Multiple contexts
 * (kernel worker, page-side `VirtualFS` instances) each hold their own
 * lazily-populated index and each call `flush()`, so whichever context
 * wrote LAST replaced the sidecar with its private view — including
 * entries it never touched and whose cached kind/size had drifted from
 * reality. In production that re-poisoned a freshly repaired sidecar
 * within hours and bricked boot twice (EISDIR in `crossCopy`, see #1984).
 *
 * The fix: a context may only overwrite sidecar entries for paths it
 * actually mutated (its "dirty" paths); everything else is preserved from
 * the sidecar currently on disk. Combined with the cross-context Web Lock
 * around the read-merge-write (taken by the caller in `virtual-fs.ts`),
 * concurrent writers converge instead of clobbering each other.
 *
 * This module is deliberately DOM/OPFS-free so the merge semantics are
 * unit-testable in Node.
 */

/**
 * Opaque ZenFS inode JSON (`Inode.toJSON()`). This module never inspects
 * entries beyond identity; callers that need fields (e.g. `mode`) narrow
 * at their own boundary.
 */
export type SidecarInodeJson = object;

/**
 * Path → opaque inode map from ZenFS `Index.toJSON().entries`.
 */
export type SidecarEntries = { [path: string]: SidecarInodeJson };

/**
 * Parsed shape of the sidecar document — `Index.toJSON()` from
 * `@zenfs/core` (`{ version, maxSize, entries }`). Entry values are
 * opaque inode records; this module never inspects them beyond identity.
 */
export interface SidecarIndexJson {
  version?: number;
  maxSize?: number;
  entries?: SidecarEntries;
}

/**
 * Paths this context mutated since its last successful sidecar write.
 *
 * - `paths` — exact entries to overwrite (files written, directories
 *   created, symlinks minted, plus their ancestor directories, whose
 *   index records materialize alongside).
 * - `prefixes` — subtrees whose entire on-disk entry set is superseded by
 *   this context's view (recursive removes, renames): every sidecar entry
 *   at or under the prefix is dropped, then every in-memory entry at or
 *   under it is copied in — so deleted children disappear instead of
 *   resurrecting from the on-disk base.
 */
export interface SidecarDirtyState {
  paths: Set<string>;
  prefixes: Set<string>;
}

/** Whether `key` is `prefix` itself or a descendant path of it. */
function isUnder(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(prefix === '/' ? '/' : `${prefix}/`);
}

/**
 * The one sidecar path that must never appear in its own entry map.
 *
 * ZenFS's `crossCopy` indexes the physical `.metadata.json` file, so it turns
 * up in the in-memory index every session. Persisting a self-entry is a latent
 * boot brick: its recorded size can never match reality (writing the sidecar
 * changes the very size stored), so the next cold-boot `crossCopy` hits a "file
 * data size mismatch" and fails. Both the merge result AND any full-snapshot
 * recovery flush — which skips {@link mergeSidecarEntries} entirely — must
 * strip it. The boot self-heal in `sidecar-repair.ts` drops any already on disk.
 */
export const SIDECAR_SELF_ENTRY = '/.metadata.json';

/** Drop the self-referential sidecar entry from `doc` in place; returns `doc`. */
export function stripSidecarSelfEntry(doc: SidecarIndexJson): SidecarIndexJson {
  if (doc.entries) delete doc.entries[SIDECAR_SELF_ENTRY];
  return doc;
}

/**
 * Merge this context's in-memory index (`own`) over the sidecar currently
 * on disk (`onDisk`), constrained to the context's dirty paths/prefixes.
 *
 * Top-level fields (`version`, `maxSize`) come from `own` — they describe
 * the writing code's format, not filesystem state. The root entry `/` is
 * taken from `own` when present (it is structural and always current).
 */
export function mergeSidecarEntries(
  onDisk: SidecarIndexJson,
  own: SidecarIndexJson,
  dirty: SidecarDirtyState
): SidecarIndexJson {
  const ownEntries = own.entries ?? {};
  const entries: SidecarEntries = { ...(onDisk.entries ?? {}) };

  if ('/' in ownEntries) entries['/'] = ownEntries['/'];

  for (const path of dirty.paths) {
    if (path in ownEntries) entries[path] = ownEntries[path];
    else delete entries[path];
  }

  for (const prefix of dirty.prefixes) {
    for (const key of Object.keys(entries)) {
      if (isUnder(key, prefix)) delete entries[key];
    }
    for (const key of Object.keys(ownEntries)) {
      if (isUnder(key, prefix)) entries[key] = ownEntries[key];
    }
  }

  const { entries: _ownEntries, ...ownRest } = own;
  // Never persist a self-entry (see {@link SIDECAR_SELF_ENTRY}); the writer
  // applies the same strip to its full-snapshot recovery path.
  return stripSidecarSelfEntry({ ...ownRest, entries });
}
