/**
 * Verifies the Python-level mount guard installed alongside the
 * `MOUNT_BOMB_FS` overlay. The guard wraps the hot stdlib FS entry
 * points so synchronous access to a mounted path raises an OSError
 * whose `strerror` carries the slicc.fs guidance — necessary because
 * CPython rebuilds OSError from the raw integer errno for stdlib
 * calls and discards the JS bomb-FS `.message`.
 *
 * The guard installer is exercised against a fake Pyodide that
 * captures `globals.set` writes + `runPythonAsync` calls, mirroring
 * the `registerSliccFsModule` test pattern (real-Pyodide behavior is
 * verified manually).
 */
import { describe, expect, it } from 'vitest';
import { formatBombMessage } from '../../../src/kernel/realm/mount-bomb-fs.js';
import {
  formatPythonMountGuardMessage,
  installPythonMountGuard,
  PYTHON_MOUNT_GUARD_SOURCE,
} from '../../../src/kernel/realm/python-mount-guard.js';

function makeFakePyodide(): {
  pyodide: Parameters<typeof installPythonMountGuard>[0];
  globalsSet: { name: string; value: unknown }[];
  ran: string[];
  syncRan: string[];
} {
  const globalsSet: { name: string; value: unknown }[] = [];
  const ran: string[] = [];
  const syncRan: string[] = [];
  const pyodide = {
    globals: {
      set(name: string, value: unknown): void {
        globalsSet.push({ name, value });
      },
    },
    async runPythonAsync(code: string): Promise<void> {
      ran.push(code);
    },
    runPython(code: string): void {
      syncRan.push(code);
    },
  } as unknown as Parameters<typeof installPythonMountGuard>[0];
  return { pyodide, globalsSet, ran, syncRan };
}

describe('formatPythonMountGuardMessage', () => {
  it('names the mount path and points at slicc.fs', () => {
    const msg = formatPythonMountGuardMessage('/mnt/kb');
    expect(msg).toContain('/mnt/kb');
    expect(msg).toContain('slicc.fs');
    expect(msg).toContain("await slicc.fs.read_text('/mnt/kb')");
    expect(msg).toContain("await slicc.fs.listdir('/mnt/kb')");
  });

  it('parity: matches the JS bomb-FS message verbatim', () => {
    // The JS bomb fires for C-level access (pandas fopen, C extensions);
    // the Python guard fires for stdlib `open`/`os.*` calls. Both must
    // surface the same guidance so the user sees a consistent message
    // regardless of which path their script tripped.
    for (const path of ['/mnt/kb', '/workspace/repo', '/mnt/bucket']) {
      expect(formatPythonMountGuardMessage(path)).toBe(formatBombMessage(path));
      expect(formatPythonMountGuardMessage(path)).toContain('slicc.fs');
    }
  });
});

describe('PYTHON_MOUNT_GUARD_SOURCE', () => {
  it('wraps the hot stdlib entry points', () => {
    // Each guarded entry point must be reassigned so calls go through
    // the wrapper. Regressions here let stdlib calls reach the C FS
    // path and surface only "I/O error" again.
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain(
      '_slicc_builtins.open = _slicc_guarded_builtins_open'
    );
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_io.open = _slicc_guarded_io_open');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_os.listdir = _slicc_make_path_guard');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_os.scandir = _slicc_make_path_guard');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_os.stat = _slicc_make_path_guard');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_os.lstat = _slicc_make_path_guard');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_os.mkdir = _slicc_make_path_guard');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_os.remove = _slicc_make_path_guard');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_os.rename = _slicc_guarded_rename');
  });

  it('skips integer file descriptors', () => {
    // `open(3, 'rb')` (re-open an inherited fd) must pass through; the
    // mount guard is a path-shaped check only.
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('if isinstance(file, int):');
  });

  it('resolves relative paths against cwd before matching', () => {
    // `os.path.abspath` normalizes against the current cwd; a relative
    // path that resolves under a mount must still trip the guard.
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_osp.abspath');
  });

  it('matches mount prefixes by equality or `prefix + "/"`', () => {
    // The bare prefix itself plus any descendant must match — both the
    // stat of the mount root and reads of child files have to fire.
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain(
      "resolved == prefix or resolved.startswith(prefix + '/')"
    );
  });

  it('raises OSError(EIO, message, path)', () => {
    // Three-arg OSError so `str(exc)` carries the friendly message,
    // not just "I/O error".
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('raise OSError(_slicc_errno.EIO, msg, str(path))');
  });

  it('reads the short-lived global the installer sets via JSON', () => {
    // The installer sets a single `__slicc_mount_data` global as a
    // JSON string; the guard parses it with `json.loads` to obtain
    // native Python list/dict values. This crosses the JS→Python
    // boundary without going through Pyodide's `JsProxy`, which is
    // not iterable and would crash `list(...)` / `dict(...)`.
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('__slicc_mount_data');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('import json as _slicc_json');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain('_slicc_json.loads(__slicc_mount_data)');
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain("_slicc_data['prefixes']");
    expect(PYTHON_MOUNT_GUARD_SOURCE).toContain("_slicc_data['messages']");
  });
});

describe('installPythonMountGuard', () => {
  it('no-ops when the mount list is empty', async () => {
    const { pyodide, globalsSet, ran } = makeFakePyodide();
    await installPythonMountGuard(pyodide, []);
    expect(globalsSet).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('passes mount prefixes + per-prefix messages into Python as a JSON string', async () => {
    const { pyodide, globalsSet, ran } = makeFakePyodide();
    const paths = ['/mnt/kb', '/workspace/repo'];
    await installPythonMountGuard(pyodide, paths);
    const dataEntry = globalsSet.find((g) => g.name === '__slicc_mount_data');
    expect(dataEntry).toBeDefined();
    // Regression: the boundary value MUST be a JSON string, never a
    // raw JS array/object. Pyodide wraps raw JS values as `JsProxy`,
    // which is not iterable — `list(...)`/`dict(...)` at the top of
    // the guard source would crash, the installer would throw, and
    // mount access would fall back to the generic `[Errno 29]`.
    expect(typeof dataEntry?.value).toBe('string');
    const parsed = JSON.parse(dataEntry?.value as string);
    expect(parsed.prefixes).toEqual(paths);
    expect(parsed.messages).toEqual({
      '/mnt/kb': formatBombMessage('/mnt/kb'),
      '/workspace/repo': formatBombMessage('/workspace/repo'),
    });
    expect(ran).toEqual([PYTHON_MOUNT_GUARD_SOURCE]);
  });

  it('only sets one boundary global (no raw JS containers leak through)', async () => {
    // Belt-and-suspenders for the JsProxy regression: even if a
    // future refactor adds a second global, it must also be a string
    // (or anything other than a non-string iterable container) so
    // the Python side never has to iterate a `JsProxy`.
    const { pyodide, globalsSet } = makeFakePyodide();
    await installPythonMountGuard(pyodide, ['/mnt/kb']);
    expect(globalsSet).toHaveLength(1);
    for (const entry of globalsSet) {
      expect(typeof entry.value).toBe('string');
    }
  });

  it('cleans up the temporary global after the guard runs', async () => {
    const { pyodide, syncRan } = makeFakePyodide();
    await installPythonMountGuard(pyodide, ['/mnt/kb']);
    expect(syncRan).toEqual(['del __slicc_mount_data']);
  });

  it('cleans up the global even when runPythonAsync throws', async () => {
    const globalsSet: { name: string; value: unknown }[] = [];
    const syncRan: string[] = [];
    const pyodide = {
      globals: {
        set(name: string, value: unknown): void {
          globalsSet.push({ name, value });
        },
      },
      async runPythonAsync(_code: string): Promise<void> {
        throw new Error('python boom');
      },
      runPython(code: string): void {
        syncRan.push(code);
      },
    } as unknown as Parameters<typeof installPythonMountGuard>[0];
    await expect(installPythonMountGuard(pyodide, ['/mnt/kb'])).rejects.toThrow(/python boom/);
    expect(syncRan).toEqual(['del __slicc_mount_data']);
  });
});
