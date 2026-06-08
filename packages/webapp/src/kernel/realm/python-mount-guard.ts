/**
 * `python-mount-guard.ts` — installs a Python-level mount guard that
 * wraps the hot stdlib FS entry points (`builtins.open`, `io.open`,
 * `os.listdir`, `os.scandir`, `os.stat`, `os.lstat`, `os.mkdir`,
 * `os.remove`, `os.rename`) so synchronous access to a mounted path
 * raises an `OSError` whose `strerror` carries the friendly slicc.fs
 * guidance.
 *
 * Companion to `mount-bomb-fs.ts`. The bomb FS sets a guiding
 * `.message` on the JS `Fs.ErrnoError`, but for stdlib calls CPython
 * discards it and rebuilds the OSError from the raw integer errno —
 * only the generic "I/O error" survives. The JS message can NEVER
 * survive the Emscripten → C → CPython errno path, so this guard
 * intercepts at the Python level (before the C FS call) and raises
 * the message directly. The bomb FS remains as the C-level backstop
 * for pandas / C-extension `fopen` paths the Python wrappers can't
 * see.
 *
 * `pathlib` and `os.walk` delegate to the wrapped stdlib entries and
 * inherit the message; non-mount paths (cwd, `/tmp`, `/workspace`)
 * pass through to the captured originals unchanged.
 */

import type { PyodideInterface } from 'pyodide';
import { formatBombMessage } from './mount-bomb-fs.js';

/**
 * Build the friendly OSError message for a mounted path. Re-exports
 * {@link formatBombMessage} so the Python guard and the JS bomb FS
 * speak the exact same string — keeps the user-facing guidance in
 * one place and makes parity testable.
 */
export function formatPythonMountGuardMessage(mountPath: string): string {
  return formatBombMessage(mountPath);
}

/**
 * Python source for the guard. Reads one module-global
 * (`__slicc_mount_data`, a JSON string) set by
 * {@link installPythonMountGuard} immediately before this runs.
 *
 * The JSON boundary sidesteps Pyodide's `JsProxy` wrapper entirely —
 * a raw JS array/object set via `pyodide.globals.set` arrives in
 * Python as a `JsProxy` that is not iterable, so `list(...)`/`dict(...)`
 * over it would raise `TypeError`. Round-tripping through a JSON
 * string keeps the payload as native Python `list`/`dict` after
 * `json.loads`.
 *
 * The guard captures the originals once (so re-running this is
 * idempotent against a freshly-imported stdlib) and wraps each entry
 * with a thin guard that:
 *   • returns the original for `int` file descriptors and any non-
 *     path-shaped argument (so e.g. `open(3, 'rb')` is unaffected);
 *   • resolves the path through `os.fspath` + `os.path.abspath` so
 *     relative paths are compared against cwd before the prefix check;
 *   • raises `OSError(errno.EIO, <friendly message>, path)` when the
 *     resolved path equals a mount prefix or sits under it
 *     (`prefix` or `prefix + '/'`);
 *   • delegates to the captured original otherwise.
 *
 * The guard is registered against the prefix list verbatim — sorting
 * doesn't matter for `equals or startswith` matching but the list is
 * small and bounded by the user's mount count.
 */
export const PYTHON_MOUNT_GUARD_SOURCE = `
import builtins as _slicc_builtins
import io as _slicc_io
import os as _slicc_os
import os.path as _slicc_osp
import errno as _slicc_errno
import json as _slicc_json

_slicc_data = _slicc_json.loads(__slicc_mount_data)
_slicc_mount_prefixes = list(_slicc_data['prefixes'])
_slicc_mount_messages = dict(_slicc_data['messages'])
del _slicc_data

def _slicc_match_mount_prefix(path):
    if path is None:
        return None
    if isinstance(path, int):
        return None
    try:
        s = _slicc_os.fspath(path)
    except TypeError:
        return None
    if isinstance(s, bytes):
        try:
            s = s.decode('utf-8', 'surrogateescape')
        except Exception:
            return None
    if not isinstance(s, str):
        return None
    try:
        resolved = _slicc_osp.abspath(s)
    except Exception:
        return None
    for prefix in _slicc_mount_prefixes:
        if resolved == prefix or resolved.startswith(prefix + '/'):
            return prefix
    return None

def _slicc_raise_mount_guard(path, prefix):
    msg = _slicc_mount_messages.get(prefix)
    if not msg:
        msg = "slicc: synchronous access to mounted path '" + prefix + "' is not supported; use the async slicc.fs module."
    raise OSError(_slicc_errno.EIO, msg, str(path))

_slicc_orig_builtins_open = _slicc_builtins.open
_slicc_orig_io_open = _slicc_io.open
_slicc_orig_listdir = _slicc_os.listdir
_slicc_orig_scandir = _slicc_os.scandir
_slicc_orig_stat = _slicc_os.stat
_slicc_orig_lstat = _slicc_os.lstat
_slicc_orig_mkdir = _slicc_os.mkdir
_slicc_orig_remove = _slicc_os.remove
_slicc_orig_rename = _slicc_os.rename

def _slicc_guarded_builtins_open(file, *args, **kwargs):
    if isinstance(file, int):
        return _slicc_orig_builtins_open(file, *args, **kwargs)
    prefix = _slicc_match_mount_prefix(file)
    if prefix is not None:
        _slicc_raise_mount_guard(file, prefix)
    return _slicc_orig_builtins_open(file, *args, **kwargs)

def _slicc_guarded_io_open(file, *args, **kwargs):
    if isinstance(file, int):
        return _slicc_orig_io_open(file, *args, **kwargs)
    prefix = _slicc_match_mount_prefix(file)
    if prefix is not None:
        _slicc_raise_mount_guard(file, prefix)
    return _slicc_orig_io_open(file, *args, **kwargs)

def _slicc_make_path_guard(orig):
    def _guarded(path, *args, **kwargs):
        prefix = _slicc_match_mount_prefix(path)
        if prefix is not None:
            _slicc_raise_mount_guard(path, prefix)
        return orig(path, *args, **kwargs)
    return _guarded

def _slicc_guarded_rename(src, dst, *args, **kwargs):
    for p in (src, dst):
        prefix = _slicc_match_mount_prefix(p)
        if prefix is not None:
            _slicc_raise_mount_guard(p, prefix)
    return _slicc_orig_rename(src, dst, *args, **kwargs)

_slicc_builtins.open = _slicc_guarded_builtins_open
_slicc_io.open = _slicc_guarded_io_open
_slicc_os.listdir = _slicc_make_path_guard(_slicc_orig_listdir)
_slicc_os.scandir = _slicc_make_path_guard(_slicc_orig_scandir)
_slicc_os.stat = _slicc_make_path_guard(_slicc_orig_stat)
_slicc_os.lstat = _slicc_make_path_guard(_slicc_orig_lstat)
_slicc_os.mkdir = _slicc_make_path_guard(_slicc_orig_mkdir)
_slicc_os.remove = _slicc_make_path_guard(_slicc_orig_remove)
_slicc_os.rename = _slicc_guarded_rename
`;

/**
 * Install the Python mount guard for the given mount prefixes.
 * No-op when {@link mountPaths} is empty.
 *
 * Sets one short-lived module global (`__slicc_mount_data`, a JSON
 * string carrying `{ prefixes, messages }`) for the guard to consume,
 * runs the wrapper, then deletes the global so it doesn't leak into
 * user code. The JSON boundary is deliberate: a raw JS array/object
 * passed through `pyodide.globals.set` would arrive in Python as a
 * non-iterable `JsProxy` and crash the guard at install time. Failures
 * bubble to the caller — {@link runPyRealm} wraps the call in
 * `try/catch` + `pushWarning` like the other registration helpers, so
 * a guard install failure degrades to the bomb-FS-only mode (which
 * still raises, just with the generic strerror).
 */
export async function installPythonMountGuard(
  pyodide: PyodideInterface,
  mountPaths: readonly string[]
): Promise<void> {
  if (mountPaths.length === 0) return;
  const messages: Record<string, string> = {};
  for (const path of mountPaths) {
    messages[path] = formatPythonMountGuardMessage(path);
  }
  const payload = JSON.stringify({ prefixes: mountPaths, messages });
  pyodide.globals.set('__slicc_mount_data', payload);
  try {
    await pyodide.runPythonAsync(PYTHON_MOUNT_GUARD_SOURCE);
  } finally {
    try {
      pyodide.runPython('del __slicc_mount_data');
    } catch {
      /* best-effort cleanup */
    }
  }
}
