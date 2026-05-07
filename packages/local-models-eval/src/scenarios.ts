/**
 * Scenario data — the corpus the eval drives through pi's agent loop.
 *
 * Each `Scenario` pairs a system + user prompt with a tool subset and
 * a verifier that decides pass/fail from the run result. Scenarios
 * that need filesystem state populate their sandbox in `setup`.
 *
 * Conventions:
 *   * Verifiers inspect `result.finalText` — the user-visible answer
 *     in the SLICC chat panel — by default. Reach into `result.rounds`
 *     only when the test *is* about call shape.
 *   * Keep prompts deterministic. No "tell me a story" — the verifier
 *     needs a stable expected substring.
 *   * Mark `expectedPass: false` (with a comment) when a scenario
 *     reliably fails on a known model weakness; the suite then prints
 *     `XFAIL` and the exit code stays 0.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Sandbox } from './sandbox.js';
import type { RunResult } from './runner.js';

export interface VerifierResult {
  ok: boolean;
  reason: string;
}

export const pass = (reason = 'ok'): VerifierResult => ({ ok: true, reason });
export const fail = (reason: string): VerifierResult => ({ ok: false, reason });

export interface Scenario {
  name: string;
  description: string;
  system: string;
  user: string;
  toolNames: string[];
  verify: (result: RunResult) => VerifierResult;
  setup?: (sandbox: Sandbox) => void;
  maxRounds: number;
  needsSandbox: boolean;
  /**
   * `false` marks a scenario that's expected to fail with the current
   * model/SwiftLM combo. Pytest convention:
   *   true  + pass  → PASS    (counts toward suite ok)
   *   true  + fail  → FAIL    (suite exits 1)
   *   false + fail  → XFAIL   (known; suite stays ok)
   *   false + pass  → XPASS   (model improved! surface, don't fail)
   */
  expectedPass: boolean;
}

// ── parallel_math ──────────────────────────────────────────────────

const MATH_SYSTEM =
  'You are a precise math assistant. Use the calculator and is_prime ' +
  'tools to answer. When you have all the values needed, give a brief ' +
  'final answer with no more tool calls.';

const MATH_USER =
  'Compute 12 multiplied by 5 and 3 multiplied by 4 IN PARALLEL ' +
  '(both calls in one response). Then multiply the two results ' +
  'together. Then check whether the final number is prime. Tell me ' +
  "both the number and whether it's prime.";

const verifyParallelMath = (r: RunResult): VerifierResult => {
  if (r.error) return fail(r.error);
  if (!r.finished) return fail('agent loop did not reach a tool-call-free turn');
  const text = r.finalText.toLowerCase();
  if (!text.includes('720')) return fail(`final answer missing 720: ${JSON.stringify(text)}`);
  if (!/\bnot\s+prime\b|composite/.test(text)) {
    return fail(`final answer didn't say it's not prime: ${JSON.stringify(text)}`);
  }
  // Round 1 must contain ≥2 tool_calls (the parallel ask). This is
  // the part that distinguishes "real parallel" from "the agent
  // serialized the calls anyway."
  const r1Calls = r.rounds[0]?.toolCalls.length ?? 0;
  if (r1Calls < 2) {
    return fail(`round 1 must emit ≥2 tool_calls (parallel); got ${r1Calls}`);
  }
  return pass(`720 not prime; round 1 had ${r1Calls} parallel calls`);
};

// ── file_exploration ───────────────────────────────────────────────

const FILE_SYSTEM =
  'You are a helpful assistant with access to a small workspace. Use ' +
  'the bash tool to discover what files exist, and read_file to ' +
  'inspect their contents. After you have the information you need, ' +
  'give a brief final answer.';

const FILE_USER =
  'How many total lines are in all the .txt files in this directory ' +
  'combined? Look at every .txt file, count its lines, and tell me ' +
  'the total.';

const FILE_FIXTURES: Record<string, string> = {
  // 5 + 12 + 3 = 20 lines total across the .txt files; markdown decoy
  // must be ignored by the agent (it isn't .txt).
  'alpha.txt': 'first line\nsecond line\nthird line\nfourth line\nfifth line\n',
  'beta.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n',
  'gamma.txt': 'alpha\nbeta\ngamma\n',
  'decoy.md': '# this file is markdown — should NOT be counted\nextra line\n',
};
const FILE_EXPECTED_TOTAL = 5 + 12 + 3;

const setupFileExploration = (sandbox: Sandbox): void => {
  for (const [name, content] of Object.entries(FILE_FIXTURES)) {
    writeFileSync(join(sandbox.root, name), content);
  }
};

const verifyFileExploration = (r: RunResult): VerifierResult => {
  if (r.error) return fail(r.error);
  if (!r.finished) return fail('agent loop did not reach a tool-call-free turn');
  const re = new RegExp(`\\b${FILE_EXPECTED_TOTAL}\\b`);
  if (!re.test(r.finalText)) {
    return fail(
      `final answer missing total ${FILE_EXPECTED_TOTAL}: ${JSON.stringify(r.finalText.slice(0, 240))}`
    );
  }
  return pass(`reported total = ${FILE_EXPECTED_TOTAL}`);
};

// ── edit_file_round_trip ───────────────────────────────────────────

const EDIT_SYSTEM =
  'You are a helpful coding assistant. Use read_file to inspect the ' +
  'current contents, edit_file to make a single string replacement, ' +
  'and read_file again to verify. Then give a brief final answer.';

const EDIT_USER =
  'The file `config.txt` in the workspace contains a placeholder value. ' +
  'Find the line `port = OLD_PORT` and change `OLD_PORT` to `5413`. ' +
  'Then verify the change and tell me what the updated line says.';

const EDIT_FIXTURES: Record<string, string> = {
  'config.txt':
    '# auto-generated config\n' + 'host = 127.0.0.1\n' + 'port = OLD_PORT\n' + 'timeout = 30\n',
};

const setupEditFile = (sandbox: Sandbox): void => {
  for (const [name, content] of Object.entries(EDIT_FIXTURES)) {
    writeFileSync(join(sandbox.root, name), content);
  }
};

const verifyEditFile = (r: RunResult): VerifierResult => {
  if (r.error) return fail(r.error);
  if (!r.finished) return fail('agent loop did not reach a tool-call-free turn');
  // The user-visible answer must mention 5413 (the actual new value).
  // A model that hallucinates the diff without calling edit_file
  // could produce "5413" in text — so also pin that the agent
  // actually called edit_file at least once.
  if (!/\b5413\b/.test(r.finalText)) {
    return fail(`final answer missing new port 5413: ${JSON.stringify(r.finalText.slice(0, 240))}`);
  }
  let sawEdit = false;
  for (const round of r.rounds) {
    for (const tc of round.toolCalls) if (tc.name === 'edit_file') sawEdit = true;
  }
  if (!sawEdit) return fail('agent never called edit_file');
  return pass('edited and verified the new port value');
};

// ── write_then_run ────────────────────────────────────────────────

const WRITE_SYSTEM =
  'You are a helpful coding assistant. To answer the user, do EXACTLY ' +
  'this workflow:\n' +
  '  1. Call write_file ONCE to create the script.\n' +
  '  2. Call bash ONCE to execute the script.\n' +
  "  3. Give a brief final answer that includes the script's actual " +
  'stdout from step 2.\n' +
  'Do not call write_file a second time unless the first call returned ' +
  'an error. Do not skip the bash step. Do not fabricate output — use ' +
  'what bash actually returned.';

const WRITE_USER =
  'Create a Python script called `greet.py` that prints exactly the ' +
  'phrase: HELLO_FROM_EVAL_4242 . Then run it with `python3 greet.py` ' +
  'and tell me what it printed.';

const WRITE_SENTINEL = 'HELLO_FROM_EVAL_4242';

const verifyWriteThenRun = (r: RunResult): VerifierResult => {
  if (r.error) return fail(r.error);
  if (!r.finished) return fail('agent loop did not reach a tool-call-free turn');
  if (!r.finalText.includes(WRITE_SENTINEL)) {
    return fail(
      `final answer missing sentinel ${WRITE_SENTINEL}: ${JSON.stringify(r.finalText.slice(0, 240))}`
    );
  }
  // Pin that the agent actually wrote AND ran the script — not just
  // that it placed the sentinel in its response.
  let sawWrite = false;
  let sawBashAfterWrite = false;
  for (const round of r.rounds) {
    for (const tc of round.toolCalls) {
      if (tc.name === 'write_file') sawWrite = true;
      else if (tc.name === 'bash' && sawWrite) sawBashAfterWrite = true;
    }
  }
  if (!sawWrite) return fail('agent never called write_file');
  if (!sawBashAfterWrite) return fail('agent called write_file but never followed up with bash');
  return pass('wrote, ran, and reported the sentinel');
};

// ── Registry ──────────────────────────────────────────────────────

export const SCENARIOS: Scenario[] = [
  {
    name: 'parallel_math',
    description:
      'Parallel tool calls in round 1, sequential rounds 2–3, final natural-language answer in round 4. Pure tools (no sandbox). is_prime expects a strict integer; if the model emits "720" as a string, pi-ai\'s validator rejects it the same way SLICC\'s would (see is_prime schema).',
    system: MATH_SYSTEM,
    user: MATH_USER,
    toolNames: ['calculator', 'is_prime'],
    verify: verifyParallelMath,
    needsSandbox: false,
    maxRounds: 6,
    expectedPass: true,
  },
  {
    name: 'file_exploration',
    description: 'bash + read_file: discover .txt files, count lines, sum across files.',
    system: FILE_SYSTEM,
    user: FILE_USER,
    toolNames: ['bash', 'read_file'],
    verify: verifyFileExploration,
    setup: setupFileExploration,
    needsSandbox: true,
    maxRounds: 8,
    expectedPass: true,
  },
  {
    name: 'edit_file_round_trip',
    description:
      'read_file + edit_file + read_file: read a config, replace a placeholder via single-string match, verify the change.',
    system: EDIT_SYSTEM,
    user: EDIT_USER,
    toolNames: ['read_file', 'edit_file'],
    verify: verifyEditFile,
    setup: setupEditFile,
    needsSandbox: true,
    maxRounds: 6,
    expectedPass: true,
  },
  {
    name: 'write_then_run',
    description:
      'write_file + bash: create a script, execute it, surface stdout in the final answer.',
    system: WRITE_SYSTEM,
    user: WRITE_USER,
    toolNames: ['write_file', 'bash'],
    verify: verifyWriteThenRun,
    needsSandbox: true,
    maxRounds: 6,
    // Qwen 3.6 35B-A3B-4bit (b644) loops on write_file in this
    // scenario — its thinking trace insists "I forgot the parameters"
    // even when the call clearly includes them. Investigation log:
    //   - --repeat-penalty 1.1 (vendor recommendation): 0/4 reliable
    //   - Qwen-recommended sampling (top_p=0.95, top_k=20):  0/5
    //   - --thinking off + alternate sampling:              1/5
    //   - SLICC-aligned tool result wording (`File written:
    //     <path>`):                                          3/5
    // After alignment we get a real ~60% pass rate (vs 0% before),
    // and the failure mode now also exercises pi-ai's strict
    // validation of empty `bash({})` calls — which is a useful
    // production-shape failure. Still flaky enough to xfail. The
    // dense Qwen 3.6 27B-4bit also fails the same way, so it's a
    // family-level weakness, not the MoE variant. Re-test on the
    // next SwiftLM/model bump; if it passes, the model has improved
    // (XPASS) and this xfail can be removed.
    expectedPass: false,
  },
];

export function scenarioByName(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
