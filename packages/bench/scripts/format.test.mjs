import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  digestMatches,
  equalWeights,
  fromBuV1,
  fromSkillCreatorEvals,
  outcome,
  pathSegment,
  sha256,
  taskDigests,
  validateEnvelope,
  validateTask,
  withDigests,
} from './format.mjs';

const TASK = {
  id: 't-1',
  title: 'A task',
  task: 'Do the thing.',
  rubric: '## Items\nA1_one — first\nA2_two — second\n',
  weights: { A1_one: 60, A2_two: 40 },
};

describe('pathSegment', () => {
  it('keeps safe names and makes unsafe ones distinct', () => {
    expect(pathSegment('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(pathSegment('builtin+x')).toBe('builtin+x');
    expect(pathSegment('a/b')).toMatch(/^a-b-[0-9a-f]{8}$/);
    expect(pathSegment('a/b')).not.toBe(pathSegment('a b'));
    expect(pathSegment(3)).toBe('3');
  });
});

describe('taskDigests', () => {
  it('hashes the text, not whatever digest the file claims', () => {
    expect(taskDigests({ ...TASK, task_sha: 'lie' })).toEqual({
      task_sha: sha256(TASK.task),
      rubric_sha: sha256(TASK.rubric),
      weights_sha: sha256(JSON.stringify(TASK.weights)),
    });
  });
});

describe('outcome', () => {
  it('maps a rubric score onto pass / partial / fail', () => {
    expect(outcome(1)).toBe('pass');
    expect(outcome(0.4)).toBe('partial');
    expect(outcome(0)).toBe('fail');
    expect(outcome(Number.NaN)).toBe('fail');
    expect(outcome(undefined)).toBe('fail');
  });
});

describe('validateTask', () => {
  it('accepts a well-formed task, with or without digests', () => {
    expect(validateTask(TASK)).toEqual([]);
    expect(validateTask(withDigests(TASK))).toEqual([]);
  });

  it('names every problem the judge and scorer would trip on', () => {
    expect(validateTask(null)).toEqual(['task is not an object']);
    const errors = validateTask({
      id: '',
      task: ' ',
      rubric: 'A1_x',
      weights: { A1_x: 50, 'bad id': 0, A3_missing: 10 },
    });
    expect(errors.join('\n')).toMatch(/id is missing/);
    expect(errors.join('\n')).toMatch(/task text is missing/);
    expect(errors.join('\n')).toMatch(/"bad id" is not an identifier/);
    expect(errors.join('\n')).toMatch(/weight of bad id must be a positive integer/);
    expect(errors.join('\n')).toMatch(/rubric never names item A3_missing/);
    expect(errors.join('\n')).toMatch(/sum to 60, not 100/);
    expect(validateTask({ ...TASK, rubric: '' })).toContain('t-1: rubric is missing');
    expect(validateTask({ ...TASK, weights: [] })).toEqual([
      't-1: weights must be an object of item id → integer',
    ]);
    expect(validateTask({ ...TASK, weights: {} })).toContain('t-1: weights has no items');
  });

  it('checks recorded digests against the text', () => {
    expect(validateTask({ ...TASK, task_sha: sha256('other') })).toEqual([
      't-1: task_sha does not match the task text',
    ]);
  });

  it('validates the slicc extension', () => {
    expect(
      validateTask({
        ...TASK,
        slicc: {
          website: 'https://x',
          skills: ['a'],
          timeoutSeconds: 60,
          requires: ['gmail'],
          files: [{ from: 'a', to: '/w/a' }],
        },
      })
    ).toEqual([]);
    expect(validateTask({ ...TASK, slicc: [] })).toEqual(['t-1: slicc must be an object']);
    const errors = validateTask({
      ...TASK,
      slicc: {
        website: 1,
        skills: 'a',
        requires: [1],
        timeoutSeconds: 0,
        files: [{ from: 'a', to: 'rel' }],
      },
    });
    expect(errors).toHaveLength(5);
  });
});

describe('validateEnvelope', () => {
  it('requires a name and a task list, and rejects duplicate ids', () => {
    expect(validateEnvelope({})).toEqual(['a task set is { benchmark, tasks: [...] }']);
    expect(validateEnvelope({ benchmark: 'B', tasks: [TASK] })).toEqual([]);
    expect(validateEnvelope({ benchmark: '', tasks: [TASK, TASK] })).toEqual([
      'benchmark name is missing',
      'duplicate task id t-1',
    ]);
  });

  it('accepts the shipped smoke set', () => {
    const smoke = JSON.parse(readFileSync(new URL('../tasks/smoke.json', import.meta.url), 'utf8'));
    expect(validateEnvelope(smoke)).toEqual([]);
    expect(smoke.n_tasks).toBe(smoke.tasks.length);
  });
});

describe('equalWeights', () => {
  it('splits 100 and gives the remainder to the first items', () => {
    expect(equalWeights(['a', 'b', 'c'])).toEqual({ a: 34, b: 33, c: 33 });
    expect(
      Object.values(equalWeights(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).reduce((x, y) => x + y)
    ).toBe(100);
  });
});

describe('fromBuV1', () => {
  it('converts an answered V1 task into a two-item rubric', () => {
    const t = fromBuV1({
      task_id: 'abcdef12-3456',
      confirmed_task: 'What is X?',
      category: 'GAIA',
      answer: '42',
    });
    expect(t.id).toBe('abcdef12-3456');
    expect(t.task).toBe('What is X?');
    expect(t.weights).toEqual({ A1_answer: 80, A2_grounded: 20 });
    expect(t.rubric).toContain('Reference answer: 42');
    expect(t.source).toEqual({ benchmark: 'BU_Bench_V1', category: 'GAIA' });
    expect(validateTask(t)).toEqual([]);
  });

  it('skips a task without a reference answer', () => {
    expect(fromBuV1({ task_id: 'x', confirmed_task: 'Do it', category: 'OM2W2' })).toBeNull();
    expect(fromBuV1(null)).toBeNull();
  });
});

describe('fromSkillCreatorEvals', () => {
  it('turns expectations into equally weighted items and requires the skill', () => {
    const set = fromSkillCreatorEvals({
      skill_name: 'speck',
      evals: [
        {
          id: 3,
          prompt: 'Set it up',
          expected_output: 'It is set up',
          files: ['evals/files/a.html'],
          expectations: ['one', 'two', 'three'],
        },
      ],
    });
    expect(set.benchmark).toBe('speck-evals');
    const [t] = set.tasks;
    expect(t.id).toBe('speck-3');
    expect(t.weights).toEqual({ E1: 34, E2: 33, E3: 33 });
    expect(t.rubric).toContain('Expected outcome: It is set up');
    expect(t.slicc).toEqual({
      skills: ['speck'],
      files: [{ from: 'evals/files/a.html', to: '/workspace/evals/files/a.html' }],
    });
    expect(validateEnvelope(set)).toEqual([]);
  });

  it('refuses input it cannot grade', () => {
    expect(() => fromSkillCreatorEvals({})).toThrow(/"evals" list/);
    expect(() => fromSkillCreatorEvals({ evals: [{ prompt: 'x', expectations: [] }] })).toThrow(
      /no expectations/
    );
  });

  it('reads the speck evals shape from the skills repo', () => {
    const set = fromSkillCreatorEvals({ evals: [{ prompt: 'p', expectations: ['e'] }] });
    expect(set.tasks[0].id).toBe('skill-1');
    expect(set.tasks[0].slicc).toEqual({ skills: ['skill'] });
  });
});

describe('upstream digests', () => {
  const task = withDigests({
    id: 't',
    task: 'Do it.',
    rubric: '## Items\nA1_x — x\n',
    weights: { A1_x: 100 },
  });
  it("accepts a full digest or upstream's 12-character short form, never a wrong one", () => {
    const full = sha256(task.rubric);
    expect(digestMatches(full, task.rubric)).toBe(true);
    expect(digestMatches(full.slice(0, 12), task.rubric)).toBe(true);
    expect(digestMatches(full.slice(0, 11), task.rubric)).toBe(false);
    expect(digestMatches('0'.repeat(12), task.rubric)).toBe(false);
    expect(digestMatches(42, task.rubric)).toBe(false);
    expect(validateTask({ ...task, rubric_sha: full.slice(0, 12) })).toEqual([]);
  });

  it('skips supplied digests for upstream sets, whose texts outgrow them', () => {
    const stale = { ...task, task_sha: '0'.repeat(64) };
    expect(validateTask(stale)).toEqual(['t: task_sha does not match the task text']);
    expect(validateTask(stale, { checkDigests: false })).toEqual([]);
    expect(validateEnvelope({ benchmark: 'B', tasks: [stale] }, { checkDigests: false })).toEqual(
      []
    );
  });
});
