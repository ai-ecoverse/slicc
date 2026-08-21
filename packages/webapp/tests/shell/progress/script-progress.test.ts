import { parse } from 'just-bash';
import { describe, expect, it } from 'vitest';
import {
  ProgressEmitter,
  type ProgressEvent,
  planScriptProgress,
  ScriptRun,
  scriptLabel,
} from '../../../src/shell/progress/index.js';

const KNOWN = new Set([
  'echo',
  'ls',
  'cat',
  'touch',
  'sleep',
  'seq',
  'wc',
  'grep',
  'curl',
  'timeout',
  'env',
  'xargs',
  'git',
]);

function steps(script: string, known = KNOWN): number | null {
  try {
    return planScriptProgress(parse(script), known).totalSteps;
  } catch {
    return null;
  }
}

describe('planScriptProgress', () => {
  it('counts a sequence of simple commands as one step each', () => {
    expect(steps('echo; echo; echo')).toBe(3);
    expect(steps('ls /\ncat a | wc -l\ngrep x b')).toBe(4);
  });

  it('counts && / || chains in full (upper bound) and builtins as zero', () => {
    expect(steps('curl -s x && ls || echo failed')).toBe(3);
    expect(steps('cd /tmp; export A=1; echo hi')).toBe(1);
    expect(steps('A=1')).toBeNull(); // zero dispatches → no unit
  });

  it('expands static for-loops and seq words', () => {
    expect(steps('for i in a b c; do echo $i; ls $i; done')).toBe(6);
    expect(steps('for i in {1..10}; do echo $i; done')).toBe(10);
    expect(steps('for i in $(seq 1 5); do echo $i; done')).toBe(6); // seq itself + 5
    expect(steps('for x in {foo,bar}{1..3}; do echo $x; done')).toBe(6);
    expect(steps('ls; for f in a b; do touch $f; done; echo done')).toBe(4);
  });

  it('counts command substitutions, wrappers and groups', () => {
    expect(steps('echo "$(wc -l f)"')).toBe(2);
    expect(steps('timeout 5 sleep 10')).toBe(2);
    expect(steps('timeout -k 1 --signal TERM 5s curl x')).toBe(2);
    expect(steps('env FOO=1 ls')).toBe(2);
    expect(steps('( ls; cat a ) | wc -l')).toBe(3);
  });

  it('is unknown for data-dependent shapes', () => {
    for (const script of [
      'for f in *.md; do cat $f; done',
      'for f in $FILES; do echo $f; done',
      'for f; do echo $f; done',
      'while read l; do echo $l; done < f',
      'if ls; then echo y; fi',
      'ls | xargs cat',
      'timeout 5 xargs ls',
      '$CMD --flag',
      'echo <(ls)',
    ]) {
      expect(steps(script), script).toBeNull();
    }
  });
});

describe('scriptLabel', () => {
  it('takes the first non-comment line, capped', () => {
    expect(scriptLabel('# setup\n\nls -la /workspace\necho done')).toBe('ls -la /workspace');
    expect(scriptLabel('   ')).toBe('bash');
    // Not truncated here — the emitter caps after scrubbing (see capLabel).
    expect(scriptLabel('x'.repeat(100)).length).toBe(100);
  });
});

describe('ScriptRun', () => {
  function setup(totalSteps: number | null) {
    let t = 0;
    const seen: ProgressEvent[] = [];
    const emitter = new ProgressEmitter({ sink: (e) => seen.push(e), now: () => t });
    const run = new ScriptRun({ totalSteps }, emitter, 'demo', () => t);
    return { seen, emitter, run, tick: (ms = 1000) => (t += ms) };
  }

  it('emits start/update/end with fraction = done/total and an ETA', () => {
    const { seen, run, tick } = setup(4);
    expect(seen[0]).toMatchObject({
      phase: 'start',
      fraction: 0,
      done: 0,
      total: 4,
      label: 'demo',
    });
    tick();
    run.stepDone();
    expect(seen.at(-1)).toMatchObject({ phase: 'update', fraction: 0.25, done: 1 });
    expect(seen.at(-1)?.etaMs).toBeCloseTo(3000);
    tick();
    run.stepDone();
    tick();
    run.stepDone();
    tick();
    run.end();
    run.end();
    expect(seen.at(-1)).toMatchObject({ phase: 'end', fraction: 1, etaMs: 0 });
    expect(seen.filter((e) => e.phase === 'end')).toHaveLength(1);
  });

  it('folds child units into the current step and routes them off the sink', () => {
    const { seen, emitter, run, tick } = setup(2);
    // A child (e.g. sleep) reports through the same emitter.
    tick();
    emitter.emit({ id: 'sleep-1', label: 'sleep 4', fraction: 0, phase: 'start' });
    tick();
    emitter.emit({ id: 'sleep-1', label: 'sleep 4', fraction: 0.5, phase: 'update' });
    expect(seen.every((e) => e.id === run.id)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ fraction: 0.25, label: 'demo · sleep 4' });
    tick();
    emitter.emit({ id: 'sleep-1', label: 'sleep 4', fraction: 1, phase: 'end' });
    run.stepDone();
    expect(seen.at(-1)).toMatchObject({ fraction: 0.5, label: 'demo' });
    run.end();
    expect(seen.at(-1)).toMatchObject({ phase: 'end', fraction: 1 });
  });

  it('is indeterminate with an unknown total unless a determinate child is running', () => {
    const { seen, emitter, run, tick } = setup(null);
    expect(seen[0].fraction).toBeUndefined();
    tick();
    emitter.emit({ id: 'net-1', label: '↓ x', fraction: undefined, phase: 'start' });
    tick();
    emitter.emit({ id: 'net-1', label: '↓ x', fraction: 0.4, phase: 'update' });
    expect(seen.at(-1)?.fraction).toBe(0.4);
    emitter.emit({ id: 'net-1', label: '↓ x', fraction: 1, phase: 'end' });
    tick(); // past the ≤4/s throttle window
    run.stepDone();
    expect(seen.at(-1)?.fraction).toBeUndefined();
    run.end();
    expect(seen.at(-1)?.fraction).toBe(1);
  });

  it('releases the emitter on end so later units reach the sink directly', () => {
    const { seen, emitter, run } = setup(1);
    run.end();
    emitter.emit({ id: 'later', label: 'later', phase: 'start' });
    expect(seen.at(-1)?.id).toBe('later');
  });
});
