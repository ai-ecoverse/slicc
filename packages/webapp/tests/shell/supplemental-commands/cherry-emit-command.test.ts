import { describe, it, expect, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import {
  createCherryEmitCommand,
  buildDefaultCherryRegistry,
  type CherryRuntimeRegistry,
} from '../../../src/shell/supplemental-commands/cherry-emit-command.js';
import { CHERRY_RUNTIME_TAG } from '../../../src/scoops/tray-sync-protocol.js';
import type { ConnectedFollowerInfo } from '../../../src/shell/supplemental-commands/host-command.js';
import type { PanelRpcClient } from '../../../src/kernel/panel-rpc.js';

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

describe('buildDefaultCherryRegistry', () => {
  function follower(runtimeId: string, runtime?: string): ConnectedFollowerInfo {
    return { runtimeId, runtime };
  }

  it('listRuntimeIds returns only cherry-tagged followers', () => {
    const reg = buildDefaultCherryRegistry({
      getFollowers: () => [
        follower('follower-cherry', CHERRY_RUNTIME_TAG),
        follower('follower-browser', 'slicc-standalone'),
        follower('follower-untagged'),
        follower('follower-cherry2', CHERRY_RUNTIME_TAG),
      ],
    });
    expect(reg.listRuntimeIds()).toEqual(['follower-cherry', 'follower-cherry2']);
  });

  it('emitSliccEvent bridges to the page via panel-RPC cherry-emit', () => {
    const call = vi.fn().mockResolvedValue({ delivered: true });
    const client = { call } as unknown as PanelRpcClient;
    const reg = buildDefaultCherryRegistry({ getPanelRpc: () => client });
    reg.emitSliccEvent('follower-cherry', 'build.done', { ok: true });
    expect(call).toHaveBeenCalledWith('cherry-emit', {
      runtimeId: 'follower-cherry',
      name: 'build.done',
      detail: { ok: true },
    });
  });

  it('emitSliccEvent is a no-op (no throw) when no panel-RPC client is published', () => {
    const reg = buildDefaultCherryRegistry({ getPanelRpc: () => null });
    expect(() => reg.emitSliccEvent('follower-cherry', 'noop', undefined)).not.toThrow();
  });
});
