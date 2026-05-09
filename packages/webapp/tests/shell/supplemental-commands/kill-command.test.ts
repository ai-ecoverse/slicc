/**
 * Tests for `kill` (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import type { CommandContext } from 'just-bash';
import { createKillCommand } from '../../../src/shell/supplemental-commands/kill-command.js';
import { ProcessManager } from '../../../src/kernel/process-manager.js';

const mockCtx = {} as CommandContext;

describe('kill command', () => {
  it('default signal is SIGTERM', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute([String(proc.pid)], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(proc.terminatedBy).toBe('SIGTERM');
    expect(proc.abort.signal.aborted).toBe(true);
  });

  it('-INT sends SIGINT', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['-INT', String(proc.pid)], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(proc.terminatedBy).toBe('SIGINT');
  });

  it('-9 sends SIGKILL', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['-9', String(proc.pid)], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(proc.terminatedBy).toBe('SIGKILL');
  });

  it('-s SIGINT works with explicit name', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['-s', 'SIGINT', String(proc.pid)], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(proc.terminatedBy).toBe('SIGINT');
  });

  it('-s INT (without SIG prefix) also works', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['-s', 'INT', String(proc.pid)], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(proc.terminatedBy).toBe('SIGINT');
  });

  it('signals multiple pids in one call', async () => {
    const pm = new ProcessManager();
    const a = pm.spawn({ kind: 'shell', argv: ['a'], owner: { kind: 'cone' } });
    const b = pm.spawn({ kind: 'shell', argv: ['b'], owner: { kind: 'cone' } });
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['-INT', String(a.pid), String(b.pid)], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(a.terminatedBy).toBe('SIGINT');
    expect(b.terminatedBy).toBe('SIGINT');
  });

  it('returns exit 1 with an error message on unknown pid', async () => {
    const pm = new ProcessManager();
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['99999'], mockCtx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no such process');
  });

  it('returns exit 1 if any pid in a batch fails', async () => {
    const pm = new ProcessManager();
    const a = pm.spawn({ kind: 'shell', argv: ['a'], owner: { kind: 'cone' } });
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['-INT', String(a.pid), '99999'], mockCtx);
    expect(result.exitCode).toBe(1);
    expect(a.terminatedBy).toBe('SIGINT'); // first pid still got it
    expect(result.stderr).toContain('99999');
  });

  it('rejects already-terminated processes', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.exit(proc.pid, 0);
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute([String(proc.pid)], mockCtx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already terminated');
  });

  it('-STOP pauses the process gate (Phase 6)', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['-STOP', String(proc.pid)], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(proc.gate.isPaused()).toBe(true);
    expect(proc.abort.signal.aborted).toBe(false);
  });

  it('-CONT resumes the process gate (Phase 6)', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(proc.pid, 'SIGSTOP');
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['-CONT', String(proc.pid)], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(proc.gate.isPaused()).toBe(false);
  });

  it('-s SIGSTOP / -s SIGCONT also work', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const cmd = createKillCommand({ processManager: pm });
    expect((await cmd.execute(['-s', 'SIGSTOP', String(proc.pid)], mockCtx)).exitCode).toBe(0);
    expect(proc.gate.isPaused()).toBe(true);
    expect((await cmd.execute(['-s', 'SIGCONT', String(proc.pid)], mockCtx)).exitCode).toBe(0);
    expect(proc.gate.isPaused()).toBe(false);
  });

  it('rejects malformed pids', async () => {
    const pm = new ProcessManager();
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['abc'], mockCtx);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('invalid pid');
  });

  it('--help prints usage', async () => {
    const cmd = createKillCommand({ processManager: new ProcessManager() });
    const result = await cmd.execute(['--help'], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('SIGTERM');
  });

  it('falls back to globalThis.__slicc_pm when no DI is provided', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'system' } });
    (globalThis as Record<string, unknown>).__slicc_pm = pm;
    try {
      const cmd = createKillCommand();
      const result = await cmd.execute(['-INT', String(proc.pid)], mockCtx);
      expect(result.exitCode).toBe(0);
      expect(proc.terminatedBy).toBe('SIGINT');
    } finally {
      delete (globalThis as Record<string, unknown>).__slicc_pm;
    }
  });

  it('errors when no pids supplied (other than --help)', async () => {
    const pm = new ProcessManager();
    const cmd = createKillCommand({ processManager: pm });
    const result = await cmd.execute(['-INT'], mockCtx);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no pids');
  });
});
