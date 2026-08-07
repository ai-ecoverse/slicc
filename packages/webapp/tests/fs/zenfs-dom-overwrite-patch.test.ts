import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the OPFS full-overwrite patch.
//
// `@zenfs/dom`'s WebAccess backend opened every write with
// `createWritable({ keepExistingData: true })`. Chromium honors that by copying
// the entire existing file into the swap file before the first byte is written,
// so a write costs O(file size) even when it replaces the whole file — a 92 MB
// rewrite measured 480 ms with the copy and 240 ms without.
//
// The quota effect is worse than the latency one: `IndexFS.touch` only narrows
// the in-memory inode and nothing ever truncates the handle, so the tail of a
// shrunk file survives on disk forever. Rewriting a 92 MB file as 4 MB left
// 92 MB on disk — 88 MB of OPFS quota that no later write can reclaim, on a
// filesystem whose failures under pressure are exactly what #1979 tracks.
//
// patches/@zenfs+dom+<ver>.patch keeps the copy only for writes that need it
// (a non-zero offset, or a buffer that does not span the indexed size). This
// test fails if the patch is missing or stops applying.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const UNCONDITIONAL_COPY = 'createWritable({ keepExistingData: true })';

describe('@zenfs/dom full-overwrite patch', () => {
  it('does not copy the existing file on a write that spans it', () => {
    const distPath = resolve(repoRoot, 'node_modules/@zenfs/dom/dist/access.js');
    const src = readFileSync(distPath, 'utf8');

    expect(
      src.includes(UNCONDITIONAL_COPY),
      `Installed @zenfs/dom still opens every write with ${UNCONDITIONAL_COPY}; ` +
        `patches/@zenfs+dom+*.patch is missing or failed to apply. That costs a ` +
        `full-file copy per write and leaks the tail of every shrunk file into ` +
        `OPFS quota permanently. Reconcile the patch — see patches/README.md.`
    ).toBe(false);
    expect(src).toContain('keepExistingData: !fullWrite');
  });
});
