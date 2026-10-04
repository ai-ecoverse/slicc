import type { Command } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { parseSudoers } from '../../src/base/sudoers.js';
import type { VirtualFS } from '../../src/fs/index.js';
import { CommandGate } from '../../src/shell/command-gate.js';
import type { SudoBroker } from '../../src/sudo/types.js';

const POLICY = parseSudoers('Cmnd  touch /workspace/gated*');
const unusedFs = {} as VirtualFS;

function brokerReturning(decision: 'allow' | 'deny'): SudoBroker {
  return { requestApproval: vi.fn(async () => ({ decision })) };
}

describe('CommandGate', () => {
  it('is a no-op wrap when sudo is unwired', async () => {
    const gate = new CommandGate({ getSudo: () => undefined, fs: unusedFs });
    const execute = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const cmd: Command = { name: 'touch', execute };
    const wrapped = gate.wrapCommandForSudo(cmd);
    expect(wrapped).toBe(cmd);
    expect(gate.isTransparentGatingEnabled()).toBe(false);
  });

  it('denies a gated dispatch and skips execute', async () => {
    const broker = brokerReturning('deny');
    const gate = new CommandGate({
      getSudo: () => ({ getPolicy: () => POLICY, broker }),
      fs: unusedFs,
    });
    const execute = vi.fn(async () => ({ stdout: 'ran', stderr: '', exitCode: 0 }));
    const wrapped = gate.wrapCommandForSudo({ name: 'touch', execute });
    const result = await wrapped.execute(['/workspace/gated.txt'], {
      env: new Map(),
    } as never);
    expect(execute).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(77);
  });

  it('consumes a one-shot bypass so a second dispatch of the same subject prompts', async () => {
    const broker = brokerReturning('deny');
    const gate = new CommandGate({
      getSudo: () => ({ getPolicy: () => POLICY, broker }),
      fs: unusedFs,
    });
    gate.registerSudoBypass('touch /workspace/gated.txt');
    const first = await gate.gateCommandDispatch('touch', ['/workspace/gated.txt']);
    const second = await gate.gateCommandDispatch('touch', ['/workspace/gated.txt']);
    expect(first).toBeNull();
    expect(second?.exitCode).toBe(77);
    expect(broker.requestApproval).toHaveBeenCalledOnce();
  });

  it('queues Always grants and flushes them through the injected sink', async () => {
    const persistCommandGrant = vi.fn(async () => undefined);
    const broker: SudoBroker = {
      requestApproval: vi.fn(async () => ({ decision: 'always' as const })),
    };
    const gate = new CommandGate({
      getSudo: () => ({ getPolicy: () => POLICY, broker, persistCommandGrant }),
      fs: unusedFs,
    });
    const allowed = await gate.gateCommandDispatch('touch', ['/workspace/gated.txt']);
    expect(allowed).toBeNull();
    expect(persistCommandGrant).not.toHaveBeenCalled();
    await gate.flushPendingCommandGrants();
    expect(persistCommandGrant).toHaveBeenCalledWith('touch /workspace/gated.txt');
  });
});
