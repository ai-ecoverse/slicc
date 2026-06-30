import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assembleBootstrap,
  buildReplyFrames,
  exitForOwnership,
  leadAndPoll,
  nextFailCount,
  nextLine,
  parseCupRecord,
  parseJoinUrl,
  parseNextArgs,
  parseSseData,
  postLickback,
  probeCup,
  resolveCupMode,
  resolvePort,
  splitCompleteLines,
} from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';
import { startFakeCup } from './_fake-cup.mjs';

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
