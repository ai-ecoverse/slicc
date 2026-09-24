/**
 * The benchmark task format, shared with browser-use's BU Bench V2.
 *
 * A task set is an envelope `{ benchmark, last_updated, n_tasks, canary?, notice?, tasks[] }`.
 * A task is `{ id, title, summary?, canary?, task, rubric, weights, task_sha?, rubric_sha?,
 * weights_sha? }`: `rubric` is markdown that defines items, and `weights` maps each item id to
 * an integer; the weights sum to 100. A judge reports one finding per item (met / violated /
 * not_assessable) and code turns findings into a score, so a task can be re-weighted without
 * re-judging a run.
 *
 * SLICC-only needs ride in an optional `slicc` object that upstream runners ignore:
 * `{ website?, skills?: string[], files?: [{ from, to }], timeoutSeconds?, requires?: string[] }`.
 *
 * Pure helpers only: no I/O, so every rule here is unit-tested.
 */

import { createHash } from 'node:crypto';

export const OUTCOMES = /** @type {const} */ (['pass', 'partial', 'fail']);

/** Hex SHA-256 of a UTF-8 string, the digest BU Bench V2 stores beside each field. */
export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * One filesystem-safe path segment per distinct value. Characters outside `[A-Za-z0-9._+-]`
 * become `-`, and a value that had any appends 8 hex digits of its SHA-256, so `a/b` and `a b`
 * never share a record file. A value that is already safe is kept as it is.
 */
export function pathSegment(value) {
  const text = String(value);
  const safe = text.replace(/[^A-Za-z0-9._+-]+/g, '-');
  return safe === text ? text : `${safe}-${sha256(text).slice(0, 8)}`;
}

/**
 * #3180's scale from a 0–1 rubric score: every item met is a pass, some weight earned is
 * partial, none is a fail.
 */
export function outcome(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'fail';
  if (score >= 1) return 'pass';
  if (score > 0) return 'partial';
  return 'fail';
}

const ITEM_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Problems with one task, as strings; an empty list means valid. Checks what the judge and
 * the scorer rely on: an id, the task text, a rubric that names every weighted item, and
 * integer weights that sum to 100.
 */
export function validateTask(task) {
  if (!task || typeof task !== 'object') return ['task is not an object'];
  const errors = [];
  const where = typeof task.id === 'string' && task.id ? task.id : '(no id)';
  if (typeof task.id !== 'string' || !task.id.trim()) errors.push('id is missing');
  if (typeof task.task !== 'string' || !task.task.trim())
    errors.push(`${where}: task text is missing`);
  if (typeof task.rubric !== 'string' || !task.rubric.trim())
    errors.push(`${where}: rubric is missing`);
  const weights = task.weights;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    errors.push(`${where}: weights must be an object of item id → integer`);
    return errors;
  }
  errors.push(...validateWeights(weights, task.rubric, where));
  errors.push(...validateDigests(task, where));
  if (task.slicc !== undefined) errors.push(...validateSliccExtension(task.slicc, where));
  return errors;
}

function validateWeights(weights, rubric, where) {
  const errors = [];
  const ids = Object.keys(weights);
  if (ids.length === 0) return [`${where}: weights has no items`];
  let sum = 0;
  for (const id of ids) {
    const w = weights[id];
    if (!ITEM_ID.test(id))
      errors.push(`${where}: item id ${JSON.stringify(id)} is not an identifier`);
    if (!Number.isInteger(w) || w <= 0)
      errors.push(`${where}: weight of ${id} must be a positive integer`);
    else sum += w;
    if (typeof rubric === 'string' && !rubric.includes(id)) {
      errors.push(`${where}: rubric never names item ${id}`);
    }
  }
  if (sum !== 100) errors.push(`${where}: weights sum to ${sum}, not 100`);
  return errors;
}

function validateDigests(task, where) {
  const errors = [];
  for (const field of ['task', 'rubric']) {
    const digest = task[`${field}_sha`];
    if (digest !== undefined && typeof task[field] === 'string' && digest !== sha256(task[field])) {
      errors.push(`${where}: ${field}_sha does not match the ${field} text`);
    }
  }
  return errors;
}

function validateSliccExtension(ext, where) {
  const errors = [];
  if (!ext || typeof ext !== 'object' || Array.isArray(ext))
    return [`${where}: slicc must be an object`];
  if (ext.website !== undefined && typeof ext.website !== 'string')
    errors.push(`${where}: slicc.website must be a string`);
  if (
    ext.skills !== undefined &&
    !(Array.isArray(ext.skills) && ext.skills.every((s) => typeof s === 'string'))
  ) {
    errors.push(`${where}: slicc.skills must be a list of skill names`);
  }
  if (
    ext.requires !== undefined &&
    !(Array.isArray(ext.requires) && ext.requires.every((s) => typeof s === 'string'))
  ) {
    errors.push(`${where}: slicc.requires must be a list of strings`);
  }
  if (
    ext.timeoutSeconds !== undefined &&
    !(Number.isInteger(ext.timeoutSeconds) && ext.timeoutSeconds > 0)
  ) {
    errors.push(`${where}: slicc.timeoutSeconds must be a positive integer`);
  }
  if (ext.files !== undefined) {
    const ok =
      Array.isArray(ext.files) &&
      ext.files.every(
        (f) => f && typeof f.from === 'string' && typeof f.to === 'string' && f.to.startsWith('/')
      );
    if (!ok) errors.push(`${where}: slicc.files must be [{ from, to }] with an absolute VFS "to"`);
  }
  return errors;
}

/** Problems with a whole task set: the envelope, each task, and duplicate ids. */
export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || !Array.isArray(envelope.tasks)) {
    return ['a task set is { benchmark, tasks: [...] }'];
  }
  const errors = [];
  if (typeof envelope.benchmark !== 'string' || !envelope.benchmark.trim())
    errors.push('benchmark name is missing');
  const seen = new Set();
  for (const task of envelope.tasks) {
    errors.push(...validateTask(task));
    if (task && typeof task.id === 'string') {
      if (seen.has(task.id)) errors.push(`duplicate task id ${task.id}`);
      seen.add(task.id);
    }
  }
  return errors;
}

/** Split 100 across `n` items: equal shares, the remainder going to the first items. */
export function equalWeights(ids) {
  const base = Math.floor(100 / ids.length);
  let extra = 100 - base * ids.length;
  const weights = {};
  for (const id of ids) {
    weights[id] = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
  }
  return weights;
}

/** The task, rubric and weights digests, computed from the text (never trusted from the file). */
export function taskDigests(task) {
  return {
    task_sha: sha256(task.task),
    rubric_sha: sha256(task.rubric),
    weights_sha: sha256(JSON.stringify(task.weights)),
  };
}

/** Fill in the `*_sha` digests the way BU Bench V2 records them. */
export function withDigests(task) {
  return { ...task, ...taskDigests(task) };
}

/**
 * A BU Bench V1 task (`{ task_id, confirmed_task, category, answer? }`) in the V2 shape. V1 is
 * judged pass/fail against its reference answer, so only answered tasks convert: the rubric has
 * one item for the answer and one for grounding it in pages the agent actually visited, which
 * is what V1's judge enforces with "the agent did not make up any information".
 * Returns null for a task without an answer.
 */
export function fromBuV1(v1, benchmark = 'BU_Bench_V1') {
  if (!v1 || typeof v1.answer !== 'string' || !v1.answer.trim()) return null;
  const rubric = [
    `# Rubric: ${benchmark} ${v1.category} task ${v1.task_id}`,
    '',
    '## How to judge',
    'Judge from the trajectory, the final result, and the screenshots only.',
    '',
    '## Source facts',
    `Reference answer: ${v1.answer}`,
    '',
    '## Items',
    'A1_answer — The final result gives the reference answer. Formatting may differ; the value may not.',
    'A2_grounded — The trajectory shows the agent reading the answer from a page or tool result, not reciting it.',
  ].join('\n');
  return withDigests({
    id: v1.task_id,
    title: `${v1.category} ${v1.task_id.slice(0, 8)}`,
    summary: `${benchmark} ${v1.category} task with a reference answer.`,
    task: v1.confirmed_task,
    rubric,
    weights: { A1_answer: 80, A2_grounded: 20 },
    source: { benchmark, category: v1.category },
  });
}

/**
 * Anthropic skill-creator evals (`{ skill_name, evals: [{ id, prompt, expected_output?, files?,
 * expectations: string[] }] }`) as a task set: each expectation becomes one equally weighted
 * rubric item, and the skill becomes the task's required skill.
 */
export function fromSkillCreatorEvals(doc) {
  if (!doc || !Array.isArray(doc.evals))
    throw new Error('skill-creator evals need an "evals" list');
  const skill = typeof doc.skill_name === 'string' ? doc.skill_name : 'skill';
  const tasks = doc.evals.map((e, index) => {
    const expectations = Array.isArray(e.expectations)
      ? e.expectations.filter((x) => typeof x === 'string')
      : [];
    if (!expectations.length) throw new Error(`eval ${e.id ?? index} has no expectations`);
    const ids = expectations.map((_, i) => `E${i + 1}`);
    const rubric = [
      `# Rubric: ${skill} eval ${e.id ?? index + 1}`,
      '',
      '## How to judge',
      'Judge from the trajectory, the final result, the output files, and the screenshots only.',
      ...(e.expected_output
        ? ['', '## Source facts', `Expected outcome: ${e.expected_output}`]
        : []),
      '',
      '## Items',
      ...expectations.map((text, i) => `${ids[i]} — ${text}`),
    ].join('\n');
    return withDigests({
      id: `${skill}-${e.id ?? index + 1}`,
      title: `${skill} eval ${e.id ?? index + 1}`,
      task: e.prompt,
      rubric,
      weights: equalWeights(ids),
      slicc: {
        skills: [skill],
        ...(Array.isArray(e.files) && e.files.length
          ? { files: e.files.map((f) => ({ from: f, to: `/workspace/${f}` })) }
          : {}),
      },
    });
  });
  return {
    benchmark: `${skill}-evals`,
    last_updated: new Date().toISOString().slice(0, 10),
    n_tasks: tasks.length,
    tasks,
  };
}
