import type { PyodideInterface } from 'pyodide';
import { formatBombMessage } from './mount-bomb-fs.js';

export function formatPythonMountGuardMessage(mountPath: string): string {
  return formatBombMessage(mountPath);
}

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
    } catch {}
  }
}
