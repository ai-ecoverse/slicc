import type { CommandContext, ExecResult, IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { createSudoCommand } from '../../../src/shell/supplemental-commands/sudo-command.js';
import type { SudoBroker, SudoDecision } from '../../../src/sudo/types.js';

function brokerReturning(decision: SudoDecision): SudoBroker {
  return { requestApproval: vi.fn(async () => decision) };
}

interface MockCtxOptions {
  cwd?: string;
  exec?: CommandContext['exec'];
}

function createMockCtx(options: MockCtxOptions = {}): CommandContext {
  const fs: Partial<IFileSystem> = {};
  return {
    fs: fs as IFileSystem,
    cwd: options.cwd ?? '/workspace',
    env: new Map<string, string>(),
    stdin: '' as unknown as CommandContext['stdin'],
    exec: options.exec,
  };
}

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

describe('sudo command', () => {
  describe('basic shape', () => {
    it('registers under the name "sudo"', () => {
      expect(createSudoCommand().name).toBe('sudo');
    });
  });

  describe('help / usage', () => {
    it('prints help on --help and exits 0 without prompting', async () => {
      const broker = brokerReturning({ decision: 'deny' });
      const cmd = createSudoCommand({ broker });
      const result = await cmd.execute(['--help'], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: sudo');
      expect(broker.requestApproval).not.toHaveBeenCalled();
    });

    it('prints help on -h and exits 0 without prompting', async () => {
      const broker = brokerReturning({ decision: 'deny' });
      const cmd = createSudoCommand({ broker });
      const result = await cmd.execute(['-h'], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: sudo');
      expect(broker.requestApproval).not.toHaveBeenCalled();
    });

    it('errors with usage on no args and does NOT prompt', async () => {
      const broker = brokerReturning({ decision: 'allow' });
      const cmd = createSudoCommand({ broker });
      const result = await cmd.execute([], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('usage: sudo');
      expect(broker.requestApproval).not.toHaveBeenCalled();
    });
  });

  describe('graceful fallback', () => {
    it('fails with a clean message when no broker is configured', async () => {
      const cmd = createSudoCommand({});
      const result = await cmd.execute(['git', 'push'], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not configured');
    });

    it('fails with a clean message when ctx.exec is unavailable', async () => {
      const broker = brokerReturning({ decision: 'allow' });
      const cmd = createSudoCommand({ broker });
      const result = await cmd.execute(['git', 'push'], createMockCtx({ exec: undefined }));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('cannot dispatch');
      expect(broker.requestApproval).not.toHaveBeenCalled();
    });
  });

  describe('approval flow', () => {
    it('on allow: runs the inner command and returns its result verbatim', async () => {
      const broker = brokerReturning({ decision: 'allow' });
      const exec = vi.fn(async () => execResult({ stdout: 'pushed\n', stderr: '', exitCode: 0 }));
      const cmd = createSudoCommand({ broker });

      const result = await cmd.execute(['git', 'push', 'origin', 'main'], createMockCtx({ exec }));

      expect(broker.requestApproval).toHaveBeenCalledTimes(1);
      expect(broker.requestApproval).toHaveBeenCalledWith({
        kind: 'command',
        detail: 'git push origin main',
      });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith('git', {
        cwd: '/workspace',
        args: ['push', 'origin', 'main'],
      });
      expect(result).toEqual({ stdout: 'pushed\n', stderr: '', exitCode: 0 });
    });

    it('on deny: blocks the inner command and exits 1', async () => {
      const broker = brokerReturning({ decision: 'deny' });
      const exec = vi.fn(async () => execResult());
      const cmd = createSudoCommand({ broker });

      const result = await cmd.execute(['rm', '-rf', '/tmp/x'], createMockCtx({ exec }));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('approval denied');
      expect(exec).not.toHaveBeenCalled();
    });

    it('on always: persists the broker-supplied pattern then runs the inner command', async () => {
      const broker = brokerReturning({ decision: 'always', pattern: 'git push *' });
      const persistGrant = vi.fn(async () => {});
      const exec = vi.fn(async () => execResult({ exitCode: 0 }));
      const cmd = createSudoCommand({ broker, persistGrant });

      const result = await cmd.execute(['git', 'push', 'origin', 'main'], createMockCtx({ exec }));

      expect(persistGrant).toHaveBeenCalledWith('git push *');
      expect(exec).toHaveBeenCalledTimes(1);
      expect(result.exitCode).toBe(0);
    });

    it('on always with no pattern: falls back to the inner subject', async () => {
      const broker = brokerReturning({ decision: 'always' });
      const persistGrant = vi.fn(async () => {});
      const exec = vi.fn(async () => execResult());
      const cmd = createSudoCommand({ broker, persistGrant });

      await cmd.execute(['git', 'push', 'origin', 'main'], createMockCtx({ exec }));

      expect(persistGrant).toHaveBeenCalledWith('git push origin main');
    });

    it('on always: swallows a persistGrant rejection and still runs the inner command', async () => {
      const broker = brokerReturning({ decision: 'always', pattern: 'rm *' });
      const persistGrant = vi.fn(async () => {
        throw new Error('disk full');
      });
      const exec = vi.fn(async () => execResult({ exitCode: 0 }));
      const cmd = createSudoCommand({ broker, persistGrant });

      const result = await cmd.execute(['rm', '/tmp/x'], createMockCtx({ exec }));

      expect(persistGrant).toHaveBeenCalled();
      expect(exec).toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
    });
  });

  describe('dedupe (single-prompt invariant)', () => {
    it('on allow: registers a one-shot bypass for the inner subject before exec', async () => {
      const broker = brokerReturning({ decision: 'allow' });
      const suppressNextGate = vi.fn();
      const exec = vi.fn(async () => execResult());
      const cmd = createSudoCommand({ broker, suppressNextGate });

      await cmd.execute(['git', 'push', 'origin', 'main'], createMockCtx({ exec }));

      expect(suppressNextGate).toHaveBeenCalledTimes(1);
      expect(suppressNextGate).toHaveBeenCalledWith('git push origin main');
      // The bypass must be registered BEFORE the inner exec dispatches, so
      // the wrapper sees it on the next gate check.
      expect(suppressNextGate.mock.invocationCallOrder[0]).toBeLessThan(
        exec.mock.invocationCallOrder[0]
      );
    });

    it('on deny: does NOT register a bypass', async () => {
      const broker = brokerReturning({ decision: 'deny' });
      const suppressNextGate = vi.fn();
      const exec = vi.fn(async () => execResult());
      const cmd = createSudoCommand({ broker, suppressNextGate });

      await cmd.execute(['rm', '-rf', '/'], createMockCtx({ exec }));

      expect(suppressNextGate).not.toHaveBeenCalled();
    });

    it('on always: registers exactly one bypass for the inner subject', async () => {
      const broker = brokerReturning({ decision: 'always', pattern: 'git push *' });
      const persistGrant = vi.fn(async () => {});
      const suppressNextGate = vi.fn();
      const exec = vi.fn(async () => execResult());
      const cmd = createSudoCommand({ broker, persistGrant, suppressNextGate });

      await cmd.execute(['git', 'push', 'origin', 'main'], createMockCtx({ exec }));

      expect(suppressNextGate).toHaveBeenCalledTimes(1);
      expect(suppressNextGate).toHaveBeenCalledWith('git push origin main');
    });
  });

  describe('argv forwarding', () => {
    it('forwards inner argv verbatim (no shell re-parsing)', async () => {
      const broker = brokerReturning({ decision: 'allow' });
      const exec = vi.fn(async () => execResult());
      const cmd = createSudoCommand({ broker });

      await cmd.execute(
        ['echo', 'hello world', '--flag=value with spaces'],
        createMockCtx({ exec })
      );

      expect(exec).toHaveBeenCalledWith('echo', {
        cwd: '/workspace',
        args: ['hello world', '--flag=value with spaces'],
      });
    });

    it('propagates the inner command exit code', async () => {
      const broker = brokerReturning({ decision: 'allow' });
      const exec = vi.fn(async () => execResult({ exitCode: 42, stderr: 'boom\n' }));
      const cmd = createSudoCommand({ broker });

      const result = await cmd.execute(['false'], createMockCtx({ exec }));

      expect(result).toEqual({ stdout: '', stderr: 'boom\n', exitCode: 42 });
    });
  });
});
