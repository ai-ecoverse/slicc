import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { spawnScript } from './_spawn.mjs';

// cup-clean's matching/selection/planning logic (the SAFETY surface) is unit-tested
// in _lib.test.mjs (classifyCupProcess / selectCupOrphans / parsePsEntries /
// planStateCleanup). Here: the wrapper boots, honors --dry-run (touches nothing), and
// exits 0. State is isolated to a temp SLICC_DIR; SLICC_REPO_DIR points at a nonexistent
// path so no real workerd can match.

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lb-clean-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('--dry-run exits 0 and reports without touching anything', async () => {
  const r = await spawnScript('cup-clean.mjs', ['--dry-run'], {
    SLICC_DIR: dir,
    SLICC_REPO_DIR: join(dir, 'no-such-repo'),
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/Nothing to clean|Dry run — would clean/);
});

test('--help prints usage and exits 0 WITHOUT acting (the footgun guard)', async () => {
  const r = await spawnScript('cup-clean.mjs', ['--help'], { SLICC_DIR: dir });
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/Usage: cup-clean\.mjs/);
  // It must NOT have entered the sweep — match the ACTUAL sweep output (a pid line or a
  // sweep header), not the word "stopped" which legitimately appears in the usage text.
  expect(r.stdout).not.toMatch(/\(pid \d+\)|Cleaned up cup orphans|Dry run — would clean/);
});

test('an unknown flag exits 2 and does NOT act (a typo never nukes)', async () => {
  const r = await spawnScript('cup-clean.mjs', ['--dry-rn'], { SLICC_DIR: dir });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/unknown option/i);
  expect(r.stdout).not.toMatch(/\(pid \d+\)|Cleaned up cup orphans|Dry run — would clean/);
});
