/**
 * Tests for `ps` (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import type { CommandContext } from 'just-bash';
import { createPsCommand } from '../../../src/shell/supplemental-commands/ps-command.js';
import { ProcessManager } from '../../../src/kernel/process-manager.js';

const mockCtx = {} as CommandContext;

describe('ps command', () => {
  it('lists no rows when the manager is empty', async () => {
    const pm = new ProcessManager();
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute([], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PID');
    expect(result.stdout).toContain('PPID');
    expect(result.stdout).toContain('COMMAND');
    // Header only — no data rows.
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('renders one row per process with default columns', async () => {
    const pm = new ProcessManager();
    pm.spawn({ kind: 'shell', argv: ['ls', '-la'], owner: { kind: 'cone' } });
    pm.spawn({
      kind: 'tool',
      argv: ['read_file'],
      owner: { kind: 'scoop', scoopJid: 'scoop_abc1234567890' },
    });
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute([], mockCtx);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 procs
    expect(lines[1]).toMatch(/1024/);
    expect(lines[1]).toMatch(/R/); // STAT
    expect(lines[1]).toMatch(/cone/);
    expect(lines[1]).toMatch(/ls -la/);
    expect(lines[2]).toMatch(/read_file/);
    expect(lines[2]).toMatch(/scoop_abc1/); // truncated jid
  });

  it('default hides exited / killed processes (Phase 4 follow-up: --all to see them)', async () => {
    const pm = new ProcessManager();
    const a = pm.spawn({ kind: 'shell', argv: ['a'], owner: { kind: 'cone' } });
    const b = pm.spawn({ kind: 'shell', argv: ['b'], owner: { kind: 'cone' } });
    const c = pm.spawn({ kind: 'shell', argv: ['c'], owner: { kind: 'cone' } });
    pm.exit(a.pid, 0); // exited (clean)
    pm.signal(b.pid, 'SIGINT');
    pm.exit(b.pid, null); // killed
    // c is still running
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute([], mockCtx);
    const dataLines = result.stdout.trim().split('\n').slice(1);
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toMatch(/\bR\b/);
    expect(dataLines[0]).toContain('c');
  });

  it('-a (or -A / -e / --all) shows STAT Z for exited and K for killed', async () => {
    const pm = new ProcessManager();
    const a = pm.spawn({ kind: 'shell', argv: ['a'], owner: { kind: 'cone' } });
    const b = pm.spawn({ kind: 'shell', argv: ['b'], owner: { kind: 'cone' } });
    pm.exit(a.pid, 0);
    pm.signal(b.pid, 'SIGINT');
    pm.exit(b.pid, null);
    const cmd = createPsCommand({ processManager: pm });
    for (const flag of ['-a', '-A', '-e', '--all']) {
      const result = await cmd.execute([flag], mockCtx);
      const dataLines = result.stdout.trim().split('\n').slice(1);
      expect(dataLines).toHaveLength(2);
      expect(dataLines[0]).toMatch(/\bZ\b/);
      expect(dataLines[1]).toMatch(/\bK\b/);
    }
  });

  it('-T tree mode indents children under their parents', async () => {
    const pm = new ProcessManager();
    const turn = pm.spawn({
      kind: 'scoop-turn',
      argv: ['prompt', 'hi'],
      owner: { kind: 'cone' },
    });
    pm.spawn({
      kind: 'tool',
      argv: ['bash'],
      owner: { kind: 'cone' },
      ppid: turn.pid,
    });
    pm.spawn({
      kind: 'tool',
      argv: ['read_file'],
      owner: { kind: 'cone' },
      ppid: turn.pid,
    });
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute(['-T'], mockCtx);
    expect(result.exitCode).toBe(0);
    const dataLines = result.stdout.trim().split('\n').slice(1);
    // Parent first, then children with `└─` connector.
    expect(dataLines[0]).toMatch(/prompt hi/);
    expect(dataLines[1]).toMatch(/└─ bash/);
    expect(dataLines[2]).toMatch(/└─ read_file/);
  });

  it('-o filters columns', async () => {
    const pm = new ProcessManager();
    pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute(['-o', 'pid,kind,command'], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PID');
    expect(result.stdout).toContain('KIND');
    expect(result.stdout).toContain('COMMAND');
    // PPID was excluded by the -o list.
    expect(result.stdout).not.toContain('PPID');
  });

  it('-o rejects unknown columns', async () => {
    const pm = new ProcessManager();
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute(['-o', 'pid,bogus'], mockCtx);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown column');
  });

  it('falls back to globalThis.__slicc_pm when no DI is provided', async () => {
    const pm = new ProcessManager();
    pm.spawn({ kind: 'shell', argv: ['hello'], owner: { kind: 'system' } });
    (globalThis as Record<string, unknown>).__slicc_pm = pm;
    try {
      const cmd = createPsCommand();
      const result = await cmd.execute([], mockCtx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');
    } finally {
      delete (globalThis as Record<string, unknown>).__slicc_pm;
    }
  });

  it('errors clearly when no manager is available', async () => {
    delete (globalThis as Record<string, unknown>).__slicc_pm;
    const cmd = createPsCommand();
    const result = await cmd.execute([], mockCtx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no process manager');
  });

  it('--help prints usage', async () => {
    const cmd = createPsCommand({ processManager: new ProcessManager() });
    const result = await cmd.execute(['--help'], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('-T');
    expect(result.stdout).toContain('-o');
  });

  it('truncates very long argv to fit the COMMAND column', async () => {
    const pm = new ProcessManager();
    const long = 'x'.repeat(200);
    pm.spawn({ kind: 'shell', argv: [long], owner: { kind: 'cone' } });
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute([], mockCtx);
    expect(result.stdout).toContain('…');
    expect(result.stdout).not.toContain(long);
  });

  it('shell-quotes argv elements containing whitespace or shell metacharacters', async () => {
    const pm = new ProcessManager();
    pm.spawn({
      kind: 'tool',
      argv: ['bash', 'date && sleep 90 && date'],
      owner: { kind: 'cone' },
    });
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute([], mockCtx);
    // Expect: bash "date && sleep 90 && date"
    expect(result.stdout).toContain('bash "date && sleep 90 && date"');
  });

  it('leaves bare-acceptable tokens unquoted (paths, names with @ + - etc.)', async () => {
    const pm = new ProcessManager();
    pm.spawn({
      kind: 'tool',
      argv: ['read_file', '/workspace/foo.ts'],
      owner: { kind: 'cone' },
    });
    pm.spawn({ kind: 'tool', argv: ['fetch', 'https://example.com/api'], owner: { kind: 'cone' } });
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute([], mockCtx);
    expect(result.stdout).toContain('read_file /workspace/foo.ts');
    expect(result.stdout).toContain('fetch https://example.com/api');
    // No spurious quoting around either path.
    expect(result.stdout).not.toContain('"/workspace/foo.ts"');
    expect(result.stdout).not.toContain('"https://example.com/api"');
  });

  it('escapes embedded quotes and backslashes in display-quoted args', async () => {
    const pm = new ProcessManager();
    pm.spawn({
      kind: 'tool',
      argv: ['bash', 'echo "hi" \\ done'],
      owner: { kind: 'cone' },
    });
    const cmd = createPsCommand({ processManager: pm });
    const result = await cmd.execute([], mockCtx);
    expect(result.stdout).toContain('bash "echo \\"hi\\" \\\\ done"');
  });
});
