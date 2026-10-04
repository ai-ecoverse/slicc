import { describe, expect, it } from 'vitest';
import { OUTPUT_TEE_ENV, RUN_PID_ENV, runPidFromEnv } from '../../src/shell/run-env.js';

describe('runPidFromEnv', () => {
  it('returns undefined when the tag is missing or not a positive integer', () => {
    expect(runPidFromEnv(undefined)).toBeUndefined();
    expect(runPidFromEnv(new Map())).toBeUndefined();
    expect(runPidFromEnv(new Map([[RUN_PID_ENV, '0']]))).toBeUndefined();
    expect(runPidFromEnv(new Map([[RUN_PID_ENV, 'nope']]))).toBeUndefined();
  });

  it('parses a positive pid from the per-run tag', () => {
    expect(runPidFromEnv(new Map([[RUN_PID_ENV, '42']]))).toBe(42);
  });

  it('exports a distinct tee tag', () => {
    expect(OUTPUT_TEE_ENV).not.toBe(RUN_PID_ENV);
  });
});
