import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  exportMemoryCheckpoint,
  hasMemoryCheckpoint,
  importMemoryCheckpoint,
  memoryCheckpointPath,
  WORKSPACE_CLAUDE_MD,
} from './memory-checkpoint.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'bench-mem-'));
  dirs.push(d);
  return d;
}

function fakeLeader({ files = {}, failWrite = false } = {}) {
  return {
    async exec(cmd, options) {
      if (cmd.includes('cat') && cmd.includes(WORKSPACE_CLAUDE_MD)) {
        const text = files[WORKSPACE_CLAUDE_MD];
        if (text == null) return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: text, stderr: '' };
      }
      if (cmd.includes('base64 -d') && cmd.includes(WORKSPACE_CLAUDE_MD)) {
        if (failWrite) return { status: 1, stdout: '', stderr: 'disk full' };
        const b64 = options?.stdin ?? '';
        files[WORKSPACE_CLAUDE_MD] = Buffer.from(b64, 'base64').toString('utf8');
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected: ${cmd}` };
    },
  };
}

describe('memory checkpoint paths', () => {
  it('names memory/CLAUDE.md under the out dir', () => {
    expect(memoryCheckpointPath('/tmp/out')).toBe(join('/tmp/out', 'memory', 'CLAUDE.md'));
  });

  it('hasMemoryCheckpoint requires non-empty file', () => {
    const out = tmp();
    expect(hasMemoryCheckpoint(out)).toBe(false);
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(memoryCheckpointPath(out), '   \n');
    expect(hasMemoryCheckpoint(out)).toBe(false);
    writeFileSync(memoryCheckpointPath(out), '# memories\n');
    expect(hasMemoryCheckpoint(out)).toBe(true);
  });
});

describe('exportMemoryCheckpoint', () => {
  it('writes leader CLAUDE.md into the out dir', async () => {
    const out = tmp();
    const leader = fakeLeader({ files: { [WORKSPACE_CLAUDE_MD]: '# Planted\n- fact\n' } });
    const r = await exportMemoryCheckpoint(leader, out);
    expect(r).toEqual({ exported: true, bytes: Buffer.byteLength('# Planted\n- fact\n') });
    expect(readFileSync(memoryCheckpointPath(out), 'utf8')).toBe('# Planted\n- fact\n');
  });

  it('skips empty or missing CLAUDE.md without overwriting', async () => {
    const out = tmp();
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(memoryCheckpointPath(out), 'keep\n');
    const r = await exportMemoryCheckpoint(fakeLeader(), out);
    expect(r).toEqual({ exported: false, bytes: 0 });
    expect(readFileSync(memoryCheckpointPath(out), 'utf8')).toBe('keep\n');
  });

  it('throws when the leader cat fails or goes down', async () => {
    const out = tmp();
    await expect(
      exportMemoryCheckpoint(
        {
          async exec() {
            return { status: 2, stdout: '', stderr: 'boom', leaderDown: false };
          },
        },
        out
      )
    ).rejects.toThrow(/export memory checkpoint: cat exited 2/);
    await expect(
      exportMemoryCheckpoint(
        {
          async exec() {
            return { status: 0, stdout: '', stderr: '', leaderDown: true };
          },
        },
        out
      )
    ).rejects.toThrow(/export memory checkpoint/);
  });
});

describe('hasMemoryCheckpoint edge cases', () => {
  it('returns false when the path exists but cannot be read as text', () => {
    const out = tmp();
    mkdirSync(join(out, 'memory', 'CLAUDE.md'), { recursive: true });
    expect(hasMemoryCheckpoint(out)).toBe(false);
  });
});

describe('importMemoryCheckpoint', () => {
  it('restores checkpoint onto the leader', async () => {
    const out = tmp();
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(memoryCheckpointPath(out), '# Restored\n');
    const files = {};
    const r = await importMemoryCheckpoint(fakeLeader({ files }), out);
    expect(r.restored).toBe(true);
    expect(files[WORKSPACE_CLAUDE_MD]).toBe('# Restored\n');
  });

  it('returns restored:false when there is no checkpoint', async () => {
    const out = tmp();
    const r = await importMemoryCheckpoint(fakeLeader(), out);
    expect(r).toEqual({ restored: false, bytes: 0 });
  });

  it('returns restored:false for a whitespace-only checkpoint file', async () => {
    const out = tmp();
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(memoryCheckpointPath(out), '  \n');
    expect(await importMemoryCheckpoint(fakeLeader(), out)).toEqual({
      restored: false,
      bytes: 0,
    });
  });

  it('throws when the leader write fails', async () => {
    const out = tmp();
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(memoryCheckpointPath(out), '# x\n');
    await expect(importMemoryCheckpoint(fakeLeader({ failWrite: true }), out)).rejects.toThrow(
      /write exited 1/
    );
  });

  it('exports when stdout is null by treating it as empty', async () => {
    const out = tmp();
    const r = await exportMemoryCheckpoint(
      {
        async exec() {
          return { status: 0, stdout: null, stderr: '' };
        },
      },
      out
    );
    expect(r).toEqual({ exported: false, bytes: 0 });
  });
});
