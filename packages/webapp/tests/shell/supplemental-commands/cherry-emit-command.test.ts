import { describe, it, expect, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import {
  createCherryEmitCommand,
  type CherryRuntimeRegistry,
} from '../../../src/shell/supplemental-commands/cherry-emit-command.js';

function createMockCtx() {
  return {
    fs: {} as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

function runtimeRegistry(
  ids: string[]
): CherryRuntimeRegistry & { emitSliccEvent: ReturnType<typeof vi.fn> } {
  return { listRuntimeIds: () => ids, emitSliccEvent: vi.fn() };
}

describe('cherry-emit command', () => {
  it('has correct name', () => {
    expect(createCherryEmitCommand({ registry: runtimeRegistry([]) }).name).toBe('cherry-emit');
  });

  it('emits to the sole runtime when --runtime omitted', async () => {
    const reg = runtimeRegistry(['follower-a']);
    const cmd = createCherryEmitCommand({ registry: reg });
    const result = await cmd.execute(['ping', '--detail', '{"x":1}'], createMockCtx());
    expect(reg.emitSliccEvent).toHaveBeenCalledWith('follower-a', 'ping', { x: 1 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('follower-a');
  });

  it('errors (exit 1) when multiple runtimes and no --runtime', async () => {
    const reg = runtimeRegistry(['follower-a', 'follower-b']);
    const result = await createCherryEmitCommand({ registry: reg }).execute(
      ['ping'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/multiple/i);
    expect(reg.emitSliccEvent).not.toHaveBeenCalled();
  });

  it('errors (exit 1) when no runtimes are connected', async () => {
    const reg = runtimeRegistry([]);
    const result = await createCherryEmitCommand({ registry: reg }).execute(
      ['ping'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no .*runtime/i);
  });

  it('errors (exit 1) when registry is absent', async () => {
    const result = await createCherryEmitCommand({}).execute(['ping'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no .*runtime/i);
  });

  it('errors (exit 1) when --detail is the final token with no value', async () => {
    const reg = runtimeRegistry(['follower-a']);
    const result = await createCherryEmitCommand({ registry: reg }).execute(
      ['ping', '--detail'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/--detail requires a value/i);
    expect(reg.emitSliccEvent).not.toHaveBeenCalled();
  });

  it('errors (exit 1) when --runtime is the final token with no value', async () => {
    const reg = runtimeRegistry(['follower-a']);
    const result = await createCherryEmitCommand({ registry: reg }).execute(
      ['ping', '--runtime'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/--runtime requires a value/i);
    expect(reg.emitSliccEvent).not.toHaveBeenCalled();
  });

  it('errors (exit 1) when --detail JSON is invalid', async () => {
    const reg = runtimeRegistry(['follower-a']);
    const result = await createCherryEmitCommand({ registry: reg }).execute(
      ['ping', '--detail', '{bad'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/valid JSON/i);
    expect(reg.emitSliccEvent).not.toHaveBeenCalled();
  });

  it('errors (exit 1) when --runtime id is not in the registry', async () => {
    const reg = runtimeRegistry(['follower-a', 'follower-b']);
    const result = await createCherryEmitCommand({ registry: reg }).execute(
      ['ping', '--runtime', 'follower-z'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/follower-a, follower-b/);
    expect(reg.emitSliccEvent).not.toHaveBeenCalled();
  });
});
