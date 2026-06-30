import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assembleBootstrap,
  buildReplyFrames,
  classifyCupProcess,
  cupProfileDirFromCommand,
  exitForOwnership,
  isStopControl,
  leadAndPoll,
  nextFailCount,
  nextLine,
  parseCleanArgs,
  parseCupRecord,
  parseJoinUrl,
  parseNextArgs,
  parsePsEntries,
  parseSseData,
  planStateCleanup,
  postLickback,
  probeCup,
  resolveCupMode,
  resolvePort,
  selectCupOrphans,
  splitCompleteLines,
  takeSseBlocks,
} from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';
import { startFakeCup } from './_fake-cup.mjs';

describe('takeSseBlocks', () => {
  test('splits complete `\\n\\n`-delimited blocks and carries the partial remainder', () => {
    const { blocks, rest } = takeSseBlocks('data: a\n\ndata: b\n\ndata: c');
    expect(blocks).toEqual(['data: a', 'data: b']);
    expect(rest).toBe('data: c'); // trailing partial (no terminator yet) kept
  });
  test('no complete block yet → empty blocks, whole buffer as rest', () => {
    expect(takeSseBlocks('data: par')).toEqual({ blocks: [], rest: 'data: par' });
  });
  test('a trailing terminator leaves an empty remainder', () => {
    expect(takeSseBlocks('data: a\n\n')).toEqual({ blocks: ['data: a'], rest: '' });
  });
});

describe('isStopControl', () => {
  test('true for an SSE block carrying an `event: lickback-control` field line', () => {
    expect(isStopControl('event: lickback-control\ndata: stop')).toBe(true);
  });
  test('false for a normal chat data block', () => {
    expect(isStopControl('data: {"kind":"chat","text":"hi"}')).toBe(false);
  });
  test('false for a `: ping` keepalive comment', () => {
    expect(isStopControl(': ping')).toBe(false);
  });
  test('false for an event-less / garbage block', () => {
    expect(isStopControl('')).toBe(false);
    expect(isStopControl('not an sse frame at all')).toBe(false);
    // A browser-pushed event is always a `data:` line — it can never forge the
    // `event:` field, even if its payload mentions lickback-control.
    expect(isStopControl('data: {"text":"event: lickback-control"}')).toBe(false);
  });
});

describe('classifyCupProcess (cup-clean SAFETY core)', () => {
  const REPO = '/Users/ben/github/ai-ecoverse/slicc/.claude/worktrees/substrate-bridge';

  test('classifies cup infrastructure by distinctive markers', () => {
    expect(classifyCupProcess('node /x/.bin/tsx packages/node-server/src/index.ts --cup')).toBe(
      'cup-node'
    );
    expect(
      classifyCupProcess(
        `node ${REPO}/.claude/skills/slicc-lickback-handler/scripts/lickback-wait.mjs`
      )
    ).toBe('lickback-script');
    expect(
      classifyCupProcess(
        `/bin/zsh -c -l eval 'frame="$(node "${REPO}/.claude/skills/slicc-lickback-handler/scripts/lickback-wait.mjs")"; code=$?'`
      )
    ).toBe('lickback-script');
    expect(
      classifyCupProcess(
        `node ${REPO}/node_modules/.bin/wrangler dev --config packages/cloudflare-worker/wrangler.jsonc --port 8787`
      )
    ).toBe('wrangler');
    expect(
      classifyCupProcess(
        `${REPO}/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve --socket-addr=entry=127.0.0.1:8787`,
        REPO
      )
    ).toBe('wrangler-runtime');
    // The cup Chrome is identified by the cup-distinctive `cup=1` launch-URL param
    // (appendCupParam) — NOT the profile name, which the default-port cup
    // (`browser-coding-agent-chrome`, no `-<port>` suffix) and a non-cup standalone
    // both share. The user-data-dir path contains a space ("Application Support").
    expect(
      classifyCupProcess(
        '/Applications/x/Google Chrome for Testing --user-data-dir=/Users/ben/Library/Application Support/Slicc/profiles/browser-coding-agent-chrome --remote-debugging-port=9222 http://localhost:8787/?bridge=ws%3A%2F%2Flocalhost%3A5710%2Fcdp&cup=1&tray=x'
      )
    ).toBe('cup-chrome');
  });

  test('NEVER classifies an everyday Chrome (default profile)', () => {
    expect(classifyCupProcess('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe(
      null
    );
  });

  test('NEVER classifies a NON-cup standalone Chrome (shares the profile name, but no cup=1)', () => {
    // `PORT=5720 npm run dev` uses the IDENTICAL browser-coding-agent-chrome-5720 profile;
    // only the missing `cup=1` distinguishes it. Killing it would be a safety violation.
    expect(
      classifyCupProcess(
        '/Applications/x/Google Chrome --user-data-dir=/Users/ben/Library/Application Support/Slicc/profiles/browser-coding-agent-chrome-5720 --remote-debugging-port=9224 http://localhost:8787/?bridge=ws'
      )
    ).toBe(null);
    // A Chrome renderer HELPER carries the profile but not the launch URL (no cup=1).
    expect(
      classifyCupProcess(
        '/Applications/x/Google Chrome Helper --type=renderer --user-data-dir=/Users/ben/Library/Application Support/Slicc/profiles/browser-coding-agent-chrome'
      )
    ).toBe(null);
  });

  test('NEVER classifies a Claude Code session as a cup orphan', () => {
    expect(classifyCupProcess('claude --dangerously-skip-permissions')).toBe(null);
    expect(
      classifyCupProcess(
        'claude --dangerously-skip-permissions --resume external brain MAIN newest'
      )
    ).toBe(null);
    expect(
      classifyCupProcess(
        '/Users/ben/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/x.sock -- /Users/ben/.local/share/claude/versions/2.1.196 --session-id fe5d2954'
      )
    ).toBe(null);
  });

  test('NEVER classifies an UNRELATED wrangler / workerd (other repo)', () => {
    expect(
      classifyCupProcess(
        'node /other/proj/node_modules/.bin/wrangler dev --config wrangler.toml --port 9000'
      )
    ).toBe(null);
    // a workerd outside our repoDir is not ours
    expect(
      classifyCupProcess('/other/proj/node_modules/@cloudflare/workerd/bin/workerd serve', REPO)
    ).toBe(null);
  });

  test('does not classify unrelated processes, nor cup-clean/cup-stop themselves', () => {
    expect(classifyCupProcess('node server.js')).toBe(null);
    expect(
      classifyCupProcess(`node ${REPO}/.claude/skills/slicc-lickback-handler/scripts/cup-clean.mjs`)
    ).toBe(null);
    expect(
      classifyCupProcess(`node ${REPO}/.claude/skills/slicc-lickback-handler/scripts/cup-stop.mjs`)
    ).toBe(null);
    expect(classifyCupProcess('')).toBe(null);
  });
});

describe('cupProfileDirFromCommand', () => {
  test('extracts the slicc profile dir from --user-data-dir, even with a space in the path', () => {
    expect(
      cupProfileDirFromCommand(
        '/x/Chrome --user-data-dir=/Users/ben/Library/Application Support/Slicc/profiles/browser-coding-agent-chrome --remote-debugging-port=9222 http://x?cup=1'
      )
    ).toBe('/Users/ben/Library/Application Support/Slicc/profiles/browser-coding-agent-chrome');
  });
  test('handles a -<port> suffix and a trailing dir (end of string)', () => {
    expect(
      cupProfileDirFromCommand(
        '/x/Chrome --user-data-dir=/a/Slicc/profiles/browser-coding-agent-chrome-5720'
      )
    ).toBe('/a/Slicc/profiles/browser-coding-agent-chrome-5720');
  });
  test('null when there is no slicc profile user-data-dir', () => {
    expect(cupProfileDirFromCommand('/x/Chrome --user-data-dir=/tmp/other')).toBe(null);
    expect(cupProfileDirFromCommand('node server.js')).toBe(null);
  });
});

describe('parseCleanArgs (cup-clean footgun guard)', () => {
  test('no args → a normal run, not dry, no profiles', () => {
    expect(parseCleanArgs([])).toEqual({ mode: 'run', dryRun: false, doProfiles: false });
  });
  test('--dry-run / --profiles flags', () => {
    expect(parseCleanArgs(['--dry-run'])).toEqual({ mode: 'run', dryRun: true, doProfiles: false });
    expect(parseCleanArgs(['--profiles'])).toEqual({
      mode: 'run',
      dryRun: false,
      doProfiles: true,
    });
    expect(parseCleanArgs(['--dry-run', '--profiles'])).toEqual({
      mode: 'run',
      dryRun: true,
      doProfiles: true,
    });
  });
  test('--help / -h → help mode (NEVER runs the cleanup), even mixed with other flags', () => {
    expect(parseCleanArgs(['--help'])).toEqual({ mode: 'help' });
    expect(parseCleanArgs(['-h'])).toEqual({ mode: 'help' });
    expect(parseCleanArgs(['--dry-run', '--help'])).toEqual({ mode: 'help' });
  });
  test('an UNKNOWN flag → error mode (does NOT act) — a typo like --dry-rn never nukes', () => {
    expect(parseCleanArgs(['--bogus'])).toEqual({ mode: 'error', unknown: ['--bogus'] });
    expect(parseCleanArgs(['--dry-rn'])).toEqual({ mode: 'error', unknown: ['--dry-rn'] });
    expect(parseCleanArgs(['--dry-run', '--nope'])).toEqual({ mode: 'error', unknown: ['--nope'] });
  });
});

describe('selectCupOrphans', () => {
  test('returns matching pids with category, excluding selfPids', () => {
    const entries = [
      { pid: 100, command: 'node x/index.ts --cup' },
      {
        pid: 200,
        command: 'node /repo/.bin/wrangler dev --config packages/cloudflare-worker/wrangler.jsonc',
      },
      { pid: 300, command: 'claude --dangerously-skip-permissions' }, // never
      { pid: 400, command: 'node cup-clean.mjs' }, // self
      { pid: 500, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, // everyday
    ];
    const orphans = selectCupOrphans(entries, { selfPids: [400] });
    expect(orphans).toEqual([
      { pid: 100, category: 'cup-node', command: 'node x/index.ts --cup' },
      {
        pid: 200,
        category: 'wrangler',
        command: 'node /repo/.bin/wrangler dev --config packages/cloudflare-worker/wrangler.jsonc',
      },
    ]);
  });
});

describe('parsePsEntries', () => {
  test('parses "PID command" lines, skipping blanks/garbage', () => {
    const out = parsePsEntries('  100 node a.js --cup\n 200 /bin/zsh -c eval\n\nnotaline\n');
    expect(out).toEqual([
      { pid: 100, command: 'node a.js --cup' },
      { pid: 200, command: '/bin/zsh -c eval' },
    ]);
  });
});

describe('planStateCleanup', () => {
  test('removes cup.json only when no live cup, always lists lickback buffers', () => {
    expect(
      planStateCleanup({
        cupJsonPath: '/s/cup.json',
        cupAlive: true,
        lickbackFiles: ['/s/a.ndjson'],
      })
    ).toEqual(['/s/a.ndjson']);
    expect(
      planStateCleanup({
        cupJsonPath: '/s/cup.json',
        cupAlive: false,
        lickbackFiles: ['/s/a.ndjson'],
      })
    ).toEqual(['/s/a.ndjson', '/s/cup.json']);
    expect(planStateCleanup({ cupJsonPath: null, cupAlive: false })).toEqual([]);
  });
});

describe('pure helpers', () => {
  test('parseCupRecord accepts a valid record and rejects malformed shapes', () => {
    expect(parseCupRecord('{"port":5710,"pid":9,"startedAt":"x"}')).toEqual({
      port: 5710,
      pid: 9,
      startedAt: 'x',
    });
    expect(parseCupRecord('not json')).toBeNull();
    expect(parseCupRecord('{"port":0,"pid":9,"startedAt":"x"}')).toBeNull();
    expect(parseCupRecord('{"port":5710,"pid":9}')).toBeNull();
  });

  test('resolvePort falls back to 5710', () => {
    expect(resolvePort({ port: 6000 })).toBe(6000);
    expect(resolvePort(null)).toBe(5710);
  });

  test('exitForOwnership maps 200/409/other -> 0/3/1', () => {
    expect(exitForOwnership(200)).toBe(0);
    expect(exitForOwnership(409)).toBe(3);
    expect(exitForOwnership(503)).toBe(1);
  });

  test('buildReplyFrames is one atomic frame carrying the whole text + done', () => {
    // F8: a single { text, done:true } POST — never a delta-then-done pair, so a
    // failed terminator can't leave the panel spinner hanging on a half turn.
    expect(buildReplyFrames('m1', 'chat', 'hi')).toEqual([
      { channel: 'chat', replyTo: 'm1', text: 'hi', done: true },
    ]);
    // Empty / decline answer: still exactly one done terminator (no text field).
    expect(buildReplyFrames('m1', 'chat', '')).toEqual([
      { channel: 'chat', replyTo: 'm1', done: true },
    ]);
  });

  test('nextFailCount resets on a connected attempt, increments only on refused (F6)', () => {
    // A stream that connected (even one that later dropped mid-read) forgives the
    // budget; only a pre-stream connect failure accumulates toward MAX_FAILS.
    expect(nextFailCount('connected', 39)).toBe(0);
    expect(nextFailCount('refused', 0)).toBe(1);
    expect(nextFailCount('refused', 5)).toBe(6);
  });

  test('splitCompleteLines excludes a trailing partial line', () => {
    expect(splitCompleteLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitCompleteLines('a\nb\n{"part')).toEqual(['a', 'b']);
    expect(splitCompleteLines('')).toEqual([]);
  });

  test('nextLine advances the cursor and stops at the end', () => {
    const c = 'a\nb\n';
    expect(nextLine(c, 0)).toEqual({ line: 'a', nextCursor: 1 });
    expect(nextLine(c, 1)).toEqual({ line: 'b', nextCursor: 2 });
    expect(nextLine(c, 2)).toEqual({ line: null, nextCursor: 2 });
  });

  test('parseNextArgs parses --wait and a channel positional', () => {
    expect(parseNextArgs(['--wait', '5', 'chat'])).toEqual({ wait: 5, channel: 'chat' });
    expect(parseNextArgs([])).toEqual({ wait: 30, channel: 'chat' });
  });

  test('parseSseData joins data lines', () => {
    expect(parseSseData('data: {"a":1}')).toBe('{"a":1}');
    expect(parseSseData(': comment')).toBeNull();
  });

  test('resolveCupMode honors SLICC_CUP_MODE, else falls back via the branch heuristic (#18)', () => {
    const saved = process.env.SLICC_CUP_MODE;
    try {
      process.env.SLICC_CUP_MODE = 'prod';
      expect(resolveCupMode()).toBe('prod');
      process.env.SLICC_CUP_MODE = 'dev';
      expect(resolveCupMode()).toBe('dev');
      delete process.env.SLICC_CUP_MODE;
      // No override + a non-git dir → gitBranch is null → cupLaunchMode → 'prod'.
      expect(resolveCupMode('/nonexistent-not-a-git-repo')).toBe('prod');
    } finally {
      if (saved === undefined) delete process.env.SLICC_CUP_MODE;
      else process.env.SLICC_CUP_MODE = saved;
    }
  });

  test('assembleBootstrap sections each source and marks a failed one unavailable (#18)', () => {
    const out = assembleBootstrap([
      { title: '/shared/CLAUDE.md', body: 'be sliccy' },
      { title: 'skills/mount', body: '' }, // failed fetch
    ]);
    expect(out).toContain('===== /shared/CLAUDE.md =====\nbe sliccy');
    expect(out).toContain('===== skills/mount =====\n(unavailable)');
  });

  test('parseJoinUrl extracts a real join URL and ignores unavailable/missing (#18)', () => {
    expect(parseJoinUrl('leader: yes\njoin_url: https://www.sliccy.ai/t/abc\nfollowers: 0')).toBe(
      'https://www.sliccy.ai/t/abc'
    );
    expect(parseJoinUrl('join_url: http://localhost:8787/t/xyz')).toBe(
      'http://localhost:8787/t/xyz'
    );
    expect(parseJoinUrl('join_url: unavailable')).toBeNull();
    expect(parseJoinUrl('leader: no')).toBeNull();
    expect(parseJoinUrl('')).toBeNull();
  });
});

describe('leadAndPoll (#18 — fire host lead, then poll host for join_url)', () => {
  test('leads then returns the join URL once it appears, passing the worker arg', async () => {
    const calls = [];
    // host returns "unavailable" twice, then a real URL on the third poll.
    const polls = [
      'join_url: unavailable',
      'join_url: unavailable',
      'join_url: https://www.sliccy.ai/t/zzz',
    ];
    const exec = async (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith('host lead')) return 'leading';
      return polls.shift() ?? 'join_url: unavailable';
    };
    const url = await leadAndPoll({
      exec,
      sleep: () => Promise.resolve(),
      workerArg: 'http://localhost:8787',
      attempts: 5,
    });
    expect(url).toBe('https://www.sliccy.ai/t/zzz');
    expect(calls[0]).toBe('host lead http://localhost:8787');
    expect(calls.slice(1)).toEqual(['host', 'host', 'host']);
  });

  test('no worker arg leads against the production hub (bare host lead)', async () => {
    const calls = [];
    const exec = async (cmd) => {
      calls.push(cmd);
      return cmd.startsWith('host lead') ? 'leading' : 'join_url: https://www.sliccy.ai/t/a';
    };
    await leadAndPoll({ exec, sleep: () => Promise.resolve(), attempts: 3 });
    expect(calls[0]).toBe('host lead');
  });

  test('returns null when no join URL appears within the budget', async () => {
    const exec = async (cmd) => (cmd.startsWith('host lead') ? 'leading' : 'join_url: unavailable');
    const url = await leadAndPoll({ exec, sleep: () => Promise.resolve(), attempts: 3 });
    expect(url).toBeNull();
  });
});

describe('fetch helpers against a fake cup', () => {
  let cup;
  beforeEach(async () => {
    cup = await startFakeCup();
  });
  afterEach(async () => {
    await cup.close();
  });

  test('probeCup is true for a cup and false otherwise', async () => {
    expect(await probeCup(cup.base)).toBe(true);
    const notCup = await startFakeCup({ statusCup: false });
    expect(await probeCup(notCup.base)).toBe(false);
    await notCup.close();
    expect(await probeCup('http://127.0.0.1:1')).toBe(false);
  });

  test('postLickback sends session header + json body', async () => {
    const res = await postLickback(cup.base, '/api/lickback/claim', 'sess-1', { channel: 'chat' });
    expect(res.status).toBe(200);
    expect(cup.received.claims[0]).toEqual({ body: { channel: 'chat' }, session: 'sess-1' });
  });
});
