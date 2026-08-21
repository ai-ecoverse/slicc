import type { Command, ResolvedCommandContext } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  PROGRESS_SKIP_COMMANDS,
  ProgressEmitter,
  type ProgressEvent,
  wrapCommandForProgress,
} from '../../../src/shell/progress/index.js';

const ctx = {} as ResolvedCommandContext;

function fakeCommand(name: string, impl?: Command['execute']): Command {
  return {
    name,
    execute: impl ?? (async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
  };
}

describe('wrapCommandForProgress', () => {
  it('emits indeterminate start/end around execute and passes the result through', async () => {
    const seen: ProgressEvent[] = [];
    const emitter = new ProgressEmitter({ sink: (e) => seen.push(e) });
    const inner = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const wrapped = wrapCommandForProgress(fakeCommand('git', inner), emitter);

    const result = await wrapped.execute(['fetch', 'origin'], ctx);

    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(inner).toHaveBeenCalledWith(['fetch', 'origin'], ctx);
    expect(seen.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(seen[0].label).toBe('git fetch origin');
    expect(seen[0].fraction).toBeUndefined();
    expect(seen[0].id).toBe(seen[1].id);
  });

  it('still emits end when execute throws', async () => {
    const seen: ProgressEvent[] = [];
    const emitter = new ProgressEmitter({ sink: (e) => seen.push(e) });
    const wrapped = wrapCommandForProgress(
      fakeCommand('git', async () => {
        throw new Error('boom');
      }),
      emitter
    );
    await expect(wrapped.execute([], ctx)).rejects.toThrow('boom');
    expect(seen.map((e) => e.phase)).toEqual(['start', 'end']);
  });

  it('returns the command untouched for skipped built-ins and self-reporting commands', () => {
    const emitter = new ProgressEmitter({ sink: () => {} });
    for (const name of ['sleep', 'echo', 'true']) {
      const cmd = fakeCommand(name);
      expect(wrapCommandForProgress(cmd, emitter)).toBe(cmd);
    }
    expect(PROGRESS_SKIP_COMMANDS.has('sleep')).toBe(true);
    const cmd = fakeCommand('sleep');
    expect(wrapCommandForProgress(cmd, emitter, { skip: new Set() })).not.toBe(cmd);
  });

  it('bypasses id allocation and emission entirely when nobody listens', async () => {
    const emitter = new ProgressEmitter(); // no sink, no tool context
    const allocate = vi.spyOn(emitter, 'allocateId');
    const wrapped = wrapCommandForProgress(fakeCommand('git'), emitter);
    await wrapped.execute([], ctx);
    expect(allocate).not.toHaveBeenCalled();
  });

  it('preserves name and trusted flag', () => {
    const emitter = new ProgressEmitter({ sink: () => {} });
    const cmd: Command = { ...fakeCommand('git'), trusted: true };
    const wrapped = wrapCommandForProgress(cmd, emitter);
    expect(wrapped.name).toBe('git');
    expect(wrapped.trusted).toBe(true);
  });
});
