import { describe, expect, it, type Mock, vi } from 'vitest';
import type { PanelRpcClient } from '../../../src/kernel/panel-rpc.js';
import { CHERRY_RUNTIME_TAG } from '../../../src/scoops/tray-sync-protocol.js';
import {
  buildDefaultCherryRegistry,
  type CherryEmitResult,
  type CherryRuntimeRegistry,
  createCherryEmitCommand,
  setCherryEmitter,
} from '../../../src/shell/supplemental-commands/cherry-emit-command.js';
import type { ConnectedFollowerInfo } from '../../../src/shell/supplemental-commands/host-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const createMockCtx = () => mockCommandContext();

type EmitMock = Mock<
  (runtimeId: string, name: string, detail: unknown) => Promise<CherryEmitResult>
>;

function runtimeRegistry(
  ids: string[],
  emit: EmitMock = vi.fn<
    (runtimeId: string, name: string, detail: unknown) => Promise<CherryEmitResult>
  >(async () => ({ delivered: true }))
): CherryRuntimeRegistry & { emitSliccEvent: EmitMock } {
  return { listRuntimeIds: () => ids, emitSliccEvent: emit };
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

  it('exits non-zero with the reason on stderr when delivery fails', async () => {
    const emit = vi.fn().mockResolvedValue({ delivered: false, reason: 'no host attached' });
    const reg = runtimeRegistry(['follower-a'], emit);
    const result = await createCherryEmitCommand({ registry: reg }).execute(
      ['ping'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no host attached');
    expect(result.stderr).toMatch(/failed to deliver 'ping'/);
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

  it('emitSliccEvent bridges to the page via panel-RPC and reports delivered', async () => {
    const call = vi.fn().mockResolvedValue({ delivered: true });
    const client = { call } as unknown as PanelRpcClient;
    const reg = buildDefaultCherryRegistry({ getPanelRpc: () => client });
    const result = await reg.emitSliccEvent('follower-cherry', 'build.done', { ok: true });
    expect(call).toHaveBeenCalledWith('cherry-emit', {
      runtimeId: 'follower-cherry',
      name: 'build.done',
      detail: { ok: true },
    });
    expect(result).toEqual({ delivered: true });
  });

  it('emitSliccEvent reports a reason (no throw) when no panel-RPC client is published', async () => {
    const reg = buildDefaultCherryRegistry({ getPanelRpc: () => null });
    const result = await reg.emitSliccEvent('follower-cherry', 'noop', undefined);
    expect(result.delivered).toBe(false);
    expect((result as { delivered: false; reason: string }).reason).toMatch(/page bridge/i);
  });

  it('emitSliccEvent reports a reason when the leader returns delivered:false', async () => {
    const call = vi.fn().mockResolvedValue({ delivered: false });
    const client = { call } as unknown as PanelRpcClient;
    const reg = buildDefaultCherryRegistry({ getPanelRpc: () => client });
    const result = await reg.emitSliccEvent('follower-cherry', 'build.done', undefined);
    expect(result.delivered).toBe(false);
    expect((result as { delivered: false; reason: string }).reason).toMatch(/not connected/i);
  });

  it('emitSliccEvent reports a reason (no throw) when the panel-RPC call rejects', async () => {
    const call = vi.fn().mockRejectedValue(new Error('channel gone'));
    const client = { call } as unknown as PanelRpcClient;
    const reg = buildDefaultCherryRegistry({ getPanelRpc: () => client });
    const result = await reg.emitSliccEvent('follower-cherry', 'build.done', undefined);
    expect(result.delivered).toBe(false);
    expect((result as { delivered: false; reason: string }).reason).toMatch(
      /panel-RPC delivery failed: channel gone/
    );
  });

  // Extension offscreen: the leader tray lives in-realm, so emit goes through a
  // direct emitter (set via setCherryEmitter) instead of the panel-RPC bridge.
  it('emitSliccEvent prefers the in-realm direct emitter and skips panel-RPC', async () => {
    const emitter = vi.fn().mockReturnValue(true);
    const call = vi.fn();
    const reg = buildDefaultCherryRegistry({
      getEmitter: () => emitter,
      getPanelRpc: () => ({ call }) as unknown as PanelRpcClient,
    });
    const result = await reg.emitSliccEvent('follower-cherry', 'build.done', { ok: true });
    expect(emitter).toHaveBeenCalledWith('follower-cherry', 'build.done', { ok: true });
    expect(call).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: true });
  });

  it('emitSliccEvent (direct emitter) reports a reason when the leader returns false', async () => {
    const reg = buildDefaultCherryRegistry({ getEmitter: () => () => false });
    const result = await reg.emitSliccEvent('follower-cherry', 'noop', undefined);
    expect(result.delivered).toBe(false);
    expect((result as { delivered: false; reason: string }).reason).toMatch(/not connected/i);
  });

  it('emitSliccEvent (direct emitter) reports a reason (no throw) when the emitter throws', async () => {
    const reg = buildDefaultCherryRegistry({
      getEmitter: () => () => {
        throw new Error('sync gone');
      },
    });
    const result = await reg.emitSliccEvent('follower-cherry', 'noop', undefined);
    expect(result.delivered).toBe(false);
    expect((result as { delivered: false; reason: string }).reason).toMatch(
      /direct emit failed: sync gone/
    );
  });

  it('honors the module-level emitter registered via setCherryEmitter()', async () => {
    const emitter = vi.fn().mockResolvedValue(true);
    setCherryEmitter(emitter);
    try {
      // No panel-RPC client published — only the direct emitter is available.
      const reg = buildDefaultCherryRegistry({ getPanelRpc: () => null });
      const result = await reg.emitSliccEvent('follower-cherry', 'x', undefined);
      expect(emitter).toHaveBeenCalledWith('follower-cherry', 'x', undefined);
      expect(result).toEqual({ delivered: true });
    } finally {
      setCherryEmitter(null);
    }
  });
});
