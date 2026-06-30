import { afterEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let cup;
afterEach(async () => {
  if (cup) await cup.close();
});

test('cup-bootstrap bundles the core docs + skills catalog into one sectioned blob', async () => {
  cup = await startFakeCup({
    vfs: {
      '/shared/CLAUDE.md': 'you are sliccy',
      '/workspace/skills/playwright-cli/SKILL.md': 'drive the browser',
      '/workspace/skills/mount/SKILL.md': 'mount remote fs',
    },
    vfsList: [
      { name: 'playwright-cli', type: 'directory' },
      { name: 'mount', type: 'directory' },
      { name: 'sprinkles', type: 'directory' },
    ],
  });
  const r = await spawnScript('cup-bootstrap.mjs', [], { CUP_BASE: cup.base });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('===== /shared/CLAUDE.md =====\nyou are sliccy');
  expect(r.stdout).toContain(
    '===== /workspace/skills/playwright-cli/SKILL.md =====\ndrive the browser'
  );
  expect(r.stdout).toContain('===== /workspace/skills/mount/SKILL.md =====\nmount remote fs');
  expect(r.stdout).toContain('- sprinkles/'); // catalog entry from vfs list
});

test('cup-bootstrap marks a missing core doc unavailable rather than dropping it', async () => {
  cup = await startFakeCup({
    vfs: { '/shared/CLAUDE.md': 'you are sliccy' }, // the two skill files are absent → 404
    vfsList: [],
  });
  const r = await spawnScript('cup-bootstrap.mjs', [], { CUP_BASE: cup.base });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('===== /workspace/skills/mount/SKILL.md =====\n(unavailable)');
});
