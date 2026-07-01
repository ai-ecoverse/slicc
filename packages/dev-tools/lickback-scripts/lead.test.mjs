import { afterEach, expect, test } from 'vitest';
import { startFakeCup } from './_fake-cup.mjs';
import { spawnScript } from './_spawn.mjs';

let cup;
afterEach(async () => {
  if (cup) await cup.close();
});

const leadingExec = (command) =>
  command.startsWith('host lead')
    ? { stdout: 'leading' }
    : { stdout: 'leader: yes\njoin_url: https://www.sliccy.ai/t/test123\nfollowers: 0' };

// End-to-end: cup-lead drives the cup's /api/shell/exec to fire `host lead`, then
// polls `host` and prints the join URL. (The poll budget / no-URL-timeout path is
// covered fast by the pure leadAndPoll unit tests in _lib.test.mjs.)
test('cup-lead fires host lead then prints the join URL once host reports it', async () => {
  cup = await startFakeCup({ exec: leadingExec });
  const r = await spawnScript('cup-lead.mjs', [], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-lead',
  });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe('https://www.sliccy.ai/t/test123');
  const cmds = cup.received.execs.map((e) => e.body.command);
  expect(cmds[0]).toBe('host lead');
  expect(cmds).toContain('host');
});

test('cup-lead leads against the production hub even in dev mode (no local-:8787 lead)', async () => {
  // The tray hub is a shared production service and the join URL must be shareable
  // (a localhost join URL is useless on a phone), so dev mode must NOT lead against
  // the local :8787 wrangler — it leads bare `host lead` (production hub).
  cup = await startFakeCup({ exec: leadingExec });
  const r = await spawnScript('cup-lead.mjs', [], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-lead',
    SLICC_CUP_MODE: 'dev',
  });
  expect(r.code).toBe(0);
  expect(cup.received.execs[0].body.command).toBe('host lead');
});

test('cup-lead honors an explicit worker URL (staging / local-hub override)', async () => {
  cup = await startFakeCup({ exec: leadingExec });
  const r = await spawnScript('cup-lead.mjs', ['https://staging.example/worker'], {
    CUP_BASE: cup.base,
    SLICC_SESSION: 'sess-lead',
  });
  expect(r.code).toBe(0);
  expect(cup.received.execs[0].body.command).toBe('host lead https://staging.example/worker');
});
