import { afterEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let cup;
afterEach(async () => {
  if (cup) await cup.close();
});

// End-to-end: cup-lead drives the cup's /api/shell/exec to fire `host lead`, then
// polls `host` and prints the join URL. (The poll budget / no-URL-timeout path is
// covered fast by the pure leadAndPoll unit tests in _lib.test.mjs.)
test('cup-lead fires host lead then prints the join URL once host reports it', async () => {
  cup = await startFakeCup({
    exec: (command) =>
      command.startsWith('host lead')
        ? { stdout: 'leading' }
        : { stdout: 'leader: yes\njoin_url: https://www.sliccy.ai/t/test123\nfollowers: 0' },
  });
  const r = await spawnScript('cup-lead.mjs', [], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-lead',
    SLICC_CUP_MODE: 'prod', // deterministic: bare `host lead` (production hub)
  });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe('https://www.sliccy.ai/t/test123');
  const cmds = cup.received.execs.map((e) => e.body.command);
  expect(cmds[0]).toBe('host lead');
  expect(cmds).toContain('host');
});
