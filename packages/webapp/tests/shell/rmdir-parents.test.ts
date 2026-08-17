import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShell } from '../../src/shell/index.js';

describe('rmdir -p (parents flag)', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShell;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: 'rmdir-parents-test', wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    shell = new AlmostBashShell({ fs });
  });

  it('removes a single directory without -p', async () => {
    await fs.mkdir('/workspace/test');
    const result = await shell.executeCommand('rmdir /workspace/test');
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await fs.exists('/workspace/test')).toBe(false);
  });

  it('rmdir -p with relative operand a/b removes b then a and stops', async () => {
    await fs.mkdir('/workspace/a/b', { recursive: true });
    const result = await shell.executeCommand('cd /workspace && rmdir -p a/b');
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await fs.exists('/workspace/a/b')).toBe(false);
    expect(await fs.exists('/workspace/a')).toBe(false);
    // /workspace itself should still exist — do NOT climb into cwd
    expect(await fs.exists('/workspace')).toBe(true);
  });

  it('rmdir -p with absolute operand /x/y removes y then x and stops at root', async () => {
    await fs.mkdir('/x/y', { recursive: true });
    const result = await shell.executeCommand('rmdir -p /x/y');
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await fs.exists('/x/y')).toBe(false);
    expect(await fs.exists('/x')).toBe(false);
    // Root should still exist
    expect(await fs.exists('/')).toBe(true);
  });

  it('rmdir -p stops early if a parent is not empty', async () => {
    await fs.mkdir('/workspace/a/b', { recursive: true });
    await fs.writeFile('/workspace/a/keep.txt', 'important');
    const result = await shell.executeCommand('rmdir -p /workspace/a/b');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to remove');
    expect(await fs.exists('/workspace/a/b')).toBe(false);
    // Parent 'a' should still exist because it has keep.txt
    expect(await fs.exists('/workspace/a')).toBe(true);
    expect(await fs.exists('/workspace/a/keep.txt')).toBe(true);
  });

  it('rmdir -p with deep relative operand a/b/c removes c, b, a and stops', async () => {
    await fs.mkdir('/workspace/a/b/c', { recursive: true });
    const result = await shell.executeCommand('cd /workspace && rmdir -p a/b/c');
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await fs.exists('/workspace/a/b/c')).toBe(false);
    expect(await fs.exists('/workspace/a/b')).toBe(false);
    expect(await fs.exists('/workspace/a')).toBe(false);
    expect(await fs.exists('/workspace')).toBe(true);
  });

  it('rmdir -p with single-component operand removes just that directory', async () => {
    await fs.mkdir('/workspace/single');
    const result = await shell.executeCommand('cd /workspace && rmdir -p single');
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await fs.exists('/workspace/single')).toBe(false);
    expect(await fs.exists('/workspace')).toBe(true);
  });

  it('rmdir without -p does not climb to parent', async () => {
    await fs.mkdir('/workspace/a/b', { recursive: true });
    const result = await shell.executeCommand('rmdir /workspace/a/b');
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await fs.exists('/workspace/a/b')).toBe(false);
    // Parent 'a' should still exist
    expect(await fs.exists('/workspace/a')).toBe(true);
  });

  it('rmdir -p handles operands with ./ prefix correctly', async () => {
    await fs.mkdir('/workspace/x/y', { recursive: true });
    const result = await shell.executeCommand('cd /workspace && rmdir -p ./x/y');
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await fs.exists('/workspace/x/y')).toBe(false);
    expect(await fs.exists('/workspace/x')).toBe(false);
    expect(await fs.exists('/workspace')).toBe(true);
  });
});
