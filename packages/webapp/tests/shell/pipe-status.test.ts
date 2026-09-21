import { describe, expect, it } from 'vitest';
import {
  appendPipelineStatus,
  applyCapturedPipeStatus,
  attachPipeStatus,
  formatPipelineStatus,
  PIPESTATUS_ENV,
  PIPESTATUS_EXIT_ENV,
  parsePipeStatus,
  scriptForPipeStatusCapture,
  takePipeStatusFromEnv,
  wrapCommandForPipeStatus,
} from '../../src/shell/pipe-status.js';

describe('wrapCommandForPipeStatus', () => {
  it('wraps a command in a group and records PIPESTATUS plus $?', () => {
    const wrapped = wrapCommandForPipeStatus('false | echo hi');
    expect(wrapped).toContain('{\nfalse | echo hi\n}');
    expect(wrapped).toContain(`${PIPESTATUS_EXIT_ENV}=$? ${PIPESTATUS_ENV}="\${PIPESTATUS[*]}"`);
    expect(wrapped).not.toContain('exit ');
  });

  it('leaves a blank command unchanged', () => {
    expect(wrapCommandForPipeStatus('')).toBe('');
    expect(wrapCommandForPipeStatus('   \n')).toBe('   \n');
  });

  it('pairs a trailing unquoted backslash so the wrapper newline is not a continuation', () => {
    expect(wrapCommandForPipeStatus('echo hi \\')).toContain('{\necho hi \\\\\n}');
    expect(wrapCommandForPipeStatus('echo hi \\\\')).toContain('{\necho hi \\\\\n}');
    expect(wrapCommandForPipeStatus('false | echo hi \\')).toContain('{\nfalse | echo hi \\\\\n}');
  });
});

describe('parsePipeStatus', () => {
  it('splits a PIPESTATUS[*] string into codes', () => {
    expect(parsePipeStatus('1 0')).toEqual([1, 0]);
    expect(parsePipeStatus('0')).toEqual([0]);
    expect(parsePipeStatus('  2 1 0  ')).toEqual([2, 1, 0]);
  });

  it('returns empty for missing or malformed input', () => {
    expect(parsePipeStatus(undefined)).toEqual([]);
    expect(parsePipeStatus('')).toEqual([]);
    expect(parsePipeStatus('1 x')).toEqual([]);
    expect(parsePipeStatus('-1 0')).toEqual([]);
    expect(parsePipeStatus('256')).toEqual([]);
  });
});

describe('takePipeStatusFromEnv', () => {
  it('reads and deletes the capture keys', () => {
    const env = {
      FOO: 'bar',
      [PIPESTATUS_ENV]: '1 0',
      [PIPESTATUS_EXIT_ENV]: '0',
    };
    expect(takePipeStatusFromEnv(env)).toEqual({ pipeStatus: [1, 0], exitCode: 0 });
    expect(env).toEqual({ FOO: 'bar' });
  });

  it('returns undefined exit when the trailer did not run', () => {
    expect(takePipeStatusFromEnv({ FOO: 'bar' })).toEqual({
      pipeStatus: [],
      exitCode: undefined,
    });
  });
});

describe('formatPipelineStatus', () => {
  it('formats a mixed pipeline', () => {
    expect(formatPipelineStatus([1, 0])).toBe('pipeline: 1 0');
    expect(formatPipelineStatus([0, 1])).toBe('pipeline: 0 1');
    expect(formatPipelineStatus([1, 1])).toBe('pipeline: 1 1');
  });

  it('omits single commands and all-zero pipelines', () => {
    expect(formatPipelineStatus([])).toBeNull();
    expect(formatPipelineStatus([0])).toBeNull();
    expect(formatPipelineStatus([1])).toBeNull();
    expect(formatPipelineStatus([0, 0])).toBeNull();
    expect(formatPipelineStatus([0, 0, 0])).toBeNull();
  });
});

describe('applyCapturedPipeStatus', () => {
  it('restores last-stage exit and attaches PIPESTATUS', () => {
    const result = applyCapturedPipeStatus(
      {
        stdout: 'ok\n',
        exitCode: 0,
        env: { [PIPESTATUS_ENV]: '1 0', [PIPESTATUS_EXIT_ENV]: '0', FOO: 'bar' },
      },
      true
    );
    expect(result.exitCode).toBe(0);
    expect(result.pipeStatus).toEqual([1, 0]);
    expect(result.env?.FOO).toBe('bar');
    expect(result.env?.[PIPESTATUS_ENV]).toBeUndefined();
  });

  it('is a no-op when capture is off', () => {
    const env = { [PIPESTATUS_ENV]: '1 0' };
    const result = applyCapturedPipeStatus({ exitCode: 7, env }, false);
    expect(result.exitCode).toBe(7);
    expect(result.pipeStatus).toBeUndefined();
    expect(env[PIPESTATUS_ENV]).toBe('1 0');
  });
});

describe('scriptForPipeStatusCapture', () => {
  it('wraps only when capture is requested', () => {
    expect(scriptForPipeStatusCapture('false | true', false)).toBe('false | true');
    expect(scriptForPipeStatusCapture('false | true', true)).toContain('PIPESTATUS');
  });
});

describe('attachPipeStatus', () => {
  it('copies pipeStatus onto a result when present', () => {
    expect(attachPipeStatus({ stdout: 'x' }, [1, 0])).toEqual({ stdout: 'x', pipeStatus: [1, 0] });
    expect(attachPipeStatus({ stdout: 'x' }, undefined)).toEqual({ stdout: 'x' });
  });
});

describe('appendPipelineStatus', () => {
  it('appends on its own line', () => {
    expect(appendPipelineStatus('hi\n', [1, 0])).toBe('hi\npipeline: 1 0');
    expect(appendPipelineStatus('hi', [1, 0])).toBe('hi\npipeline: 1 0');
    expect(appendPipelineStatus('', [1, 0])).toBe('pipeline: 1 0');
  });

  it('is a no-op when there is nothing to report', () => {
    expect(appendPipelineStatus('hi\n', [0, 0])).toBe('hi\n');
    expect(appendPipelineStatus('hi\n', undefined)).toBe('hi\n');
  });
});
