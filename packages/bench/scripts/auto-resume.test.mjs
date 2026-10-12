import { describe, expect, it, vi } from 'vitest';
import {
  autoResume,
  deadlineShards,
  eligible,
  killedShards,
  ownFailureShards,
  resumeInputs,
  summaryLines,
} from './auto-resume.mjs';

const LOST =
  'The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection.';
const DEADLINE = 'past the deadline for another run; 19 run(s) left for a resume';

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

describe('deadlineShards', () => {
  it('picks failed shards that stopped on the wall-clock deadline with runs left', () => {
    const annotations = new Map([
      [3, [DEADLINE]],
      [4, ['Process completed with exit code 1.']],
    ]);
    expect(deadlineShards(jobs, annotations)).toEqual(['Shard 2']);
  });

  it('ignores budget stops and Report-job noise', () => {
    const annotations = new Map([
      [3, ['spent $80.00 of the $80 budget; 3 run(s) left for a resume']],
      [7, [DEADLINE]],
    ]);
    expect(deadlineShards(jobs, annotations)).toEqual([]);
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
      empty: null,
      missing: undefined,
    };
    expect(resumeInputs(inputs, 42)).toEqual({
      sets: 'bu-v2',
      shards: '13',
      publish: 'false',
      'resume-run': '42',
      'auto-resumed-from': '42',
    });
    expect(resumeInputs(null, 7)).toEqual({
      'resume-run': '7',
      'auto-resumed-from': '7',
    });
  });
});

describe('eligible', () => {
  it('never kill-resumes a run that is itself an auto-resume', () => {
    expect(eligible({ 'auto-resumed-from': '' })).toBe(true);
    expect(eligible({ 'auto-resumed-from': '37828059342' })).toBe(false);
    expect(eligible(null)).toBe(false);
  });

  it('allows deadline leftovers to chain across auto-resumes', () => {
    expect(eligible({ 'auto-resumed-from': '37828059342' }, { allowDeadlineChain: true })).toBe(
      true
    );
    expect(eligible({ 'auto-resumed-from': '37828059342' }, { allowDeadlineChain: false })).toBe(
      false
    );
  });
});

/** A GitHub API double: the run's jobs, annotations per job id, and the dispatches it received. */
function fakeGithub(annotations, jobList = jobs) {
  const dispatched = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === 'POST' && path.endsWith('/actions/workflows/bench.yml/dispatches')) {
      dispatched.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/jobs')) return Response.json({ jobs: jobList });
    const m = /\/check-runs\/(\d+)\/annotations$/.exec(path);
    if (m) {
      const page = Number(new URL(url).searchParams.get('page') ?? 1);
      const list = annotations.get(Number(m[1])) ?? [];
      return Response.json(page === 1 ? list.map((message) => ({ message })) : []);
    }
    return new Response('not found', { status: 404 });
  });
  return { fetchImpl, dispatched };
}

/** Single failed shard (explore-40 shape: one shard, one leader). */
const oneFailedShard = [
  { id: 1, name: 'Plan', conclusion: 'success' },
  { id: 3, name: 'Shard 1', conclusion: 'failure' },
  { id: 7, name: 'Report', conclusion: 'failure' },
];

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

  it('dispatches when every failed shard stopped on the deadline with runs left', async () => {
    const { fetchImpl, dispatched } = fakeGithub(new Map([[3, [DEADLINE]]]), oneFailedShard);
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '' }, fetchImpl });
    expect(result).toMatchObject({
      action: 'resumed',
      killed: [],
      deadline: ['Shard 1'],
    });
    expect(result.reason).toMatch(/stopped on the deadline/);
    expect(dispatched).toHaveLength(1);
    expect(summaryLines(result, '42').join('\n')).toMatch(/deadline leftovers may chain/);
  });

  it('chains a deadline resume even when the run is already an auto-resume', async () => {
    const { fetchImpl, dispatched } = fakeGithub(new Map([[3, [DEADLINE]]]), oneFailedShard);
    const result = await autoResume({
      ...base,
      inputs: { 'auto-resumed-from': '7', sets: 'bu-v2' },
      fetchImpl,
    });
    expect(result.action).toBe('resumed');
    expect(dispatched).toEqual([
      {
        ref: 'main',
        inputs: { 'auto-resumed-from': '42', sets: 'bu-v2', 'resume-run': '42' },
      },
    ]);
  });

  it('does not kill-resume when the run is already an auto-resume', async () => {
    const { fetchImpl, dispatched } = fakeGithub(new Map([[3, [LOST]]]), oneFailedShard);
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '7' }, fetchImpl });
    expect(result.action).toBe('skipped');
    expect(result.reason).toMatch(/kill resumes once/);
    expect(dispatched).toEqual([]);
  });

  it('dispatches nothing when every failure was the bench’s own', async () => {
    const { fetchImpl, dispatched } = fakeGithub(
      new Map([[3, ['Process completed with exit code 1.']]])
    );
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '' }, fetchImpl });
    expect(result.action).toBe('none');
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

  it('leaves a run alone when one shard hit the deadline and another failed on its own', async () => {
    const { fetchImpl, dispatched } = fakeGithub(
      new Map([
        [3, [DEADLINE]],
        [4, ['Process completed with exit code 1.']],
      ])
    );
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '' }, fetchImpl });
    expect(result).toMatchObject({ action: 'none', deadline: ['Shard 2'] });
    expect(dispatched).toEqual([]);
  });

  it('still deadline-resumes when Actions adds the generic exit-code-1 annotation', async () => {
    // Real explore-40 shape (run 38173105528): deadline ::error:: plus GitHub's
    // "Process completed with exit code 1." — the latter must not veto the resume.
    const { fetchImpl, dispatched } = fakeGithub(
      new Map([[3, [DEADLINE, 'Process completed with exit code 1.']]]),
      oneFailedShard
    );
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '' }, fetchImpl });
    expect(result).toMatchObject({ action: 'resumed', deadline: ['Shard 1'] });
    expect(dispatched).toHaveLength(1);
  });

  it('leaves a deadline-marked shard alone when a real bench error annotation is also present', async () => {
    const { fetchImpl, dispatched } = fakeGithub(
      new Map([
        [
          3,
          [
            DEADLINE,
            'Process completed with exit code 1.',
            'memory extraction finished with no durable memories',
          ],
        ],
      ]),
      oneFailedShard
    );
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '' }, fetchImpl });
    expect(result.action).toBe('none');
    expect(result.reason).toMatch(/Shard 1 failed on their own/);
    expect(dispatched).toEqual([]);
  });

  it('leaves a deadline-marked shard alone when a post-step fails', async () => {
    const shard = [
      {
        ...oneFailedShard[1],
        steps: [
          { name: 'Run and judge', conclusion: 'failure' },
          { name: 'Check the out dir for plaintext task text', conclusion: 'failure' },
        ],
      },
    ];
    const { fetchImpl, dispatched } = fakeGithub(new Map([[3, [DEADLINE]]]), shard);
    const result = await autoResume({ ...base, inputs: { 'auto-resumed-from': '' }, fetchImpl });
    expect(ownFailureShards(shard, new Map([[3, [DEADLINE]]]))).toEqual(['Shard 1']);
    expect(result.action).toBe('none');
    expect(dispatched).toEqual([]);
  });
});
