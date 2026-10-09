import { describe, expect, it, vi } from 'vitest';
import { autoResume, eligible, killedShards, resumeInputs, summaryLines } from './auto-resume.mjs';

const LOST =
  'The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection.';

const jobs = [
  { id: 1, name: 'Plan', conclusion: 'success' },
  { id: 2, name: 'Shard 1', conclusion: 'success' },
  { id: 3, name: 'Shard 2', conclusion: 'failure' },
  { id: 4, name: 'Shard 3', conclusion: 'failure' },
  { id: 5, name: 'Shard 4', conclusion: 'failure' },
  { id: 6, name: 'Shard 5', conclusion: 'cancelled' },
  { id: 7, name: 'Report', conclusion: 'failure' },
];

describe('killedShards', () => {
  it('picks failed shards whose runner was taken away, by any of the three signs', () => {
    const annotations = new Map([
      [3, [LOST]],
      [4, ['Process completed with exit code 130.']],
      [5, ['Termination requested, stopping runner 7801']],
    ]);
    expect(killedShards(jobs, annotations)).toEqual(['Shard 2', 'Shard 3', 'Shard 4']);
  });

  it("leaves the bench's own failures, cancelled shards and other jobs alone", () => {
    const annotations = new Map([
      [3, ['Process completed with exit code 1.']],
      [6, [LOST]],
      [7, [LOST]],
    ]);
    expect(killedShards(jobs, annotations)).toEqual([]);
  });
});

describe('resumeInputs', () => {
  it("carries the run's inputs as strings and marks the resume", () => {
    const inputs = {
      sets: 'bu-v2',
      shards: '13',
      publish: false,
      'resume-run': '',
      'auto-resumed-from': '',
    };
    expect(resumeInputs(inputs, 42)).toEqual({
      sets: 'bu-v2',
      shards: '13',
      publish: 'false',
      'resume-run': '42',
      'auto-resumed-from': '42',
    });
  });
});

describe('eligible', () => {
  it('never resumes a run that is itself an auto-resume', () => {
    expect(eligible({ 'auto-resumed-from': '' })).toBe(true);
    expect(eligible({ 'auto-resumed-from': '37828059342' })).toBe(false);
    expect(eligible(null)).toBe(false);
  });
});

function fakeGithub(annotations) {
  const dispatched = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === 'POST' && path.endsWith('/actions/workflows/bench.yml/dispatches')) {
      dispatched.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/jobs')) return Response.json({ jobs });
    const m = /\/check-runs\/(\d+)\/annotations$/.exec(path);
    if (m)
      return Response.json((annotations.get(Number(m[1])) ?? []).map((message) => ({ message })));
    return new Response('not found', { status: 404 });
  });
  return { fetchImpl, dispatched };
}

describe('autoResume', () => {
  const base = { repo: 'o/r', runId: '42', ref: 'main', token: 't' };

  it('dispatches the run once more with resume-run when every failed shard was killed', async () => {
    const { fetchImpl, dispatched } = fakeGithub(
      new Map([
        [3, [LOST]],
        [4, ['Process completed with exit code 130.']],
        [5, ['Termination requested, stopping runner 7801']],
      ])
    );
    const inputs = { models: 'claude-haiku-5-5@max', 'resume-run': '', 'auto-resumed-from': '' };
    const result = await autoResume({ ...base, inputs, fetchImpl });
    expect(result).toMatchObject({ action: 'resumed', killed: ['Shard 2', 'Shard 3', 'Shard 4'] });
    expect(dispatched).toEqual([
      {
        ref: 'main',
        inputs: { models: 'claude-haiku-5-5@max', 'resume-run': '42', 'auto-resumed-from': '42' },
      },
    ]);
    expect(summaryLines(result, '42').join('\n')).toContain('resume-run=42');
  });

  it('dispatches nothing when every failure was the bench’s own', async () => {
    const { fetchImpl, dispatched } = fakeGithub(
      new Map([[3, ['Process completed with exit code 1.']]])
    );
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '' }, fetchImpl });
    expect(result.action).toBe('none');
    expect(dispatched).toEqual([]);
  });

  it('does not even look when the run is already an auto-resume', async () => {
    const { fetchImpl, dispatched } = fakeGithub(new Map([[3, [LOST]]]));
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '7' }, fetchImpl });
    expect(result.action).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  });

  it('says why it did not resume, and stops on an API error', async () => {
    expect(summaryLines({ action: 'none', reason: 'no shard was killed' }, '42')).toEqual([
      '### Auto-resume',
      'Not resumed: no shard was killed.',
    ]);
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 403 }));
    await expect(
      autoResume({ ...base, inputs: { 'auto-resumed-from': '' }, fetchImpl })
    ).rejects.toThrow(/HTTP 403/);
  });

  it('leaves a run alone when one shard was killed and another failed on its own', async () => {
    const { fetchImpl, dispatched } = fakeGithub(
      new Map([
        [3, [LOST]],
        [4, ['Process completed with exit code 1.']],
      ])
    );
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '' }, fetchImpl });
    expect(result).toMatchObject({ action: 'none', killed: ['Shard 2'] });
    expect(result.reason).toMatch(
      /Shard 3, Shard 4 failed on their own.*resume by hand with resume-run=42/
    );
    expect(dispatched).toEqual([]);
  });
});
