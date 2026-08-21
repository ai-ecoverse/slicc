import { parse } from 'just-bash';
import { describe, expect, it } from 'vitest';
import {
  LoopRun,
  ProgressEmitter,
  type ProgressEvent,
  planLoopProgress as planFromAst,
} from '../../../src/shell/progress/index.js';

function planLoopProgress(script: string, known: ReadonlySet<string>) {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(script);
  } catch {
    return null;
  }
  return planFromAst(ast, known);
}

const KNOWN = new Set(['echo', 'ls', 'cat', 'touch', 'sleep', 'seq', 'wc', 'grep', 'pandoc']);

describe('planLoopProgress', () => {
  it('counts literal word lists and body dispatches', () => {
    const plan = planLoopProgress('for f in a b c; do echo $f; ls $f; done', KNOWN);
    expect(plan).toEqual({ variable: 'f', total: 3, preDispatches: 0, bodyDispatches: 2 });
  });

  it('counts brace ranges, stepped ranges, char ranges and brace lists', () => {
    expect(planLoopProgress('for i in {1..100}; do echo $i; done', KNOWN)?.total).toBe(100);
    expect(planLoopProgress('for i in {0..10..2}; do echo $i; done', KNOWN)?.total).toBe(6);
    expect(planLoopProgress('for c in {a..e}; do echo $c; done', KNOWN)?.total).toBe(5);
    expect(planLoopProgress('for x in {foo,bar}{1..3}; do echo $x; done', KNOWN)?.total).toBe(6);
  });

  it('counts $(seq …) with literal bounds', () => {
    expect(planLoopProgress('for i in $(seq 1 50); do echo $i; done', KNOWN)?.total).toBe(50);
    expect(planLoopProgress('for i in $(seq 7); do echo $i; done', KNOWN)?.total).toBe(7);
    expect(planLoopProgress('for i in $(seq 1 2 9); do echo $i; done', KNOWN)?.total).toBe(5);
    expect(planLoopProgress('for i in $(seq 1 $N); do echo $i; done', KNOWN)).toBeNull();
  });

  it('accounts for dispatches before the loop, including command substitutions', () => {
    const plan = planLoopProgress(
      'ls /; X=$(cat /etc/x); echo "$(wc -l /f)"\nfor f in a b; do touch $f; done; echo done',
      KNOWN
    );
    expect(plan).toEqual({ variable: 'f', total: 2, preDispatches: 4, bodyDispatches: 1 });
  });

  it('counts pipelines per command and substitutions inside the body', () => {
    const plan = planLoopProgress(
      'for f in a b; do cat $f | grep x; echo $(wc -l $f); done',
      KNOWN
    );
    expect(plan?.bodyDispatches).toBe(4);
  });

  it('refuses data-dependent or unsafe shapes', () => {
    const cases = [
      'for f in *.md; do pandoc $f; done', // glob
      'for f in $FILES; do echo $f; done', // variable
      'for f in "$@"; do echo $f; done', // $@ (quoted)
      'for f; do echo $f; done', // implicit $@
      'for f in a b; do echo $f && ls $f; done', // short-circuit
      'for f in a b; do cd $f; done', // builtin not in registry
      'for f in a b; do unknowncmd $f; done', // unknown command
      'for f in a b; do for g in c d; do echo $g; done; done', // nested loop
      'for f in a b; do if true; then echo $f; fi; done', // nested if
      'for f in a b; do echo $f; done &', // background loop
      'ls | while read f; do echo $f; done', // not a for
      'echo a && ls; for f in a b; do echo $f; done', // && before the loop
      'for f in a b; do :; done', // body without registry dispatches
      'for f in ; do echo $f; done', // empty list
      'for f in a b; do echo $f', // parse error
    ];
    for (const script of cases) {
      expect(planLoopProgress(script, KNOWN), script).toBeNull();
    }
  });

  it('plans the first top-level loop and ignores what follows it', () => {
    const plan = planLoopProgress(
      'for f in a b; do echo $f; done; for g in c; do echo $g; done; ls && echo',
      KNOWN
    );
    expect(plan).toMatchObject({ variable: 'f', total: 2 });
  });

  it('treats assignment-only statements as zero dispatches', () => {
    const plan = planLoopProgress('N=3\nfor i in 1 2 3; do echo $i; done', KNOWN);
    expect(plan?.preDispatches).toBe(0);
  });
});

describe('LoopRun', () => {
  function run(plan: NonNullable<ReturnType<typeof planLoopProgress>>, tick = 0) {
    let t = 0;
    const seen: ProgressEvent[] = [];
    const emitter = new ProgressEmitter({ sink: (e) => seen.push(e), now: () => t });
    const loop = new LoopRun(plan, emitter, () => t);
    return {
      seen,
      loop,
      dispatch: () => {
        t += 1000 + tick;
        loop.onDispatch();
      },
    };
  }

  it('emits start, one update per completed iteration with an ETA, and end', () => {
    const plan = { variable: 'f', total: 3, preDispatches: 1, bodyDispatches: 2 };
    const { seen, loop, dispatch } = run(plan);
    expect(seen[0]).toMatchObject({
      phase: 'start',
      fraction: 0,
      total: 3,
      unit: 'iterations',
      label: 'for f (0/3)',
    });
    dispatch(); // pre-loop command
    expect(seen).toHaveLength(1);
    dispatch(); // body #1
    expect(seen).toHaveLength(1);
    dispatch(); // body #2 → iteration 1 done
    expect(seen.at(-1)).toMatchObject({
      phase: 'update',
      done: 1,
      fraction: 1 / 3,
      label: 'for f (1/3)',
    });
    expect(seen.at(-1)?.etaMs).toBeCloseTo(6000);
    dispatch();
    dispatch();
    dispatch();
    dispatch();
    expect(seen.at(-1)).toMatchObject({ done: 3, fraction: 1 });
    dispatch(); // beyond plan: clamped, no new event
    const updates = seen.filter((e) => e.phase === 'update').length;
    expect(updates).toBe(3);
    loop.end();
    loop.end();
    expect(seen.at(-1)?.phase).toBe('end');
    expect(seen.filter((e) => e.phase === 'end')).toHaveLength(1);
  });

  it('end reports the partial fraction when the loop was cut short', () => {
    const plan = { variable: 'i', total: 4, preDispatches: 0, bodyDispatches: 1 };
    const { seen, loop, dispatch } = run(plan);
    dispatch();
    loop.end();
    expect(seen.at(-1)).toMatchObject({ phase: 'end', done: 1, fraction: 0.25 });
  });
});
