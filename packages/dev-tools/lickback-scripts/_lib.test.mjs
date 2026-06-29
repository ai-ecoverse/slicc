import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildReplyFrames,
  exitForOwnership,
  nextFailCount,
  nextLine,
  parseCupRecord,
  parseNextArgs,
  parseSseData,
  postLickback,
  probeCup,
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
