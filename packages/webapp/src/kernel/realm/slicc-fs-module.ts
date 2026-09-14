import type { PyodideInterface } from 'pyodide';
import type { RealmRpcClient } from './realm-rpc.js';

export interface SliccFsJsBridge {
  listdir(path: string): Promise<string[]>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export function createSliccFsBridge(rpc: RealmRpcClient): SliccFsJsBridge {
  return {
    listdir(path: string): Promise<string[]> {
      return rpc.call<string[]>('vfs', 'readDir', [path]);
    },
    async readBytes(path: string): Promise<Uint8Array> {
      const bytes = await rpc.call<Uint8Array | ArrayBuffer>('vfs', 'readFileBinary', [path]);
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    },
    async writeBytes(path: string, data: Uint8Array): Promise<void> {
      await rpc.call<true>('vfs', 'writeFileBinary', [path, data]);
    },
    stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> {
      return rpc.call<{ isDirectory: boolean; isFile: boolean; size: number }>('vfs', 'stat', [
        path,
      ]);
    },
    exists(path: string): Promise<boolean> {
      return rpc.call<boolean>('vfs', 'exists', [path]);
    },
    async mkdir(path: string): Promise<void> {
      await rpc.call<true>('vfs', 'mkdir', [path]);
    },
    async remove(path: string): Promise<void> {
      await rpc.call<true>('vfs', 'rm', [path]);
    },
  };
}

export const PYTHON_SLICC_WRAPPER = `
import sys
import types
import js

def _build_slicc_module(_bridge):
    fs_module = types.ModuleType("slicc.fs")

    async def listdir(path):
        result = await _bridge.listdir(path)
        return [str(name) for name in result.to_py()] if hasattr(result, "to_py") else [str(name) for name in result]

    async def read_bytes(path):
        result = await _bridge.readBytes(path)
        # Pyodide returns JS Uint8Array as memoryview; coerce to bytes.
        if hasattr(result, "to_bytes"):
            return result.to_bytes()
        if isinstance(result, memoryview):
            return bytes(result)
        return bytes(result)

    async def read_text(path, encoding="utf-8"):
        data = await read_bytes(path)
        return data.decode(encoding)

    async def write_bytes(path, data):
        if isinstance(data, str):
            raise TypeError("write_bytes expects bytes-like; use write_text for str")
        if isinstance(data, (bytes, bytearray, memoryview)):
            payload = bytes(data)
        else:
            payload = bytes(data)
        # Convert Python bytes to a real JS Uint8Array before crossing
        # the realm RPC boundary. The bridge call ultimately hits
        # \`port.postMessage\` (see realm-rpc.ts), which structured-
        # clones its argument; a Python \`bytes\` would arrive as a
        # PyProxy and trigger DataCloneError. \`js.Uint8Array.new\`
        # copies the buffer into a JS typed array that clones cleanly.
        await _bridge.writeBytes(path, js.Uint8Array.new(payload))

    async def write_text(path, text, encoding="utf-8"):
        if not isinstance(text, str):
            raise TypeError("write_text expects str; use write_bytes for bytes")
        await write_bytes(path, text.encode(encoding))

    async def stat(path):
        result = await _bridge.stat(path)
        obj = result.to_py() if hasattr(result, "to_py") else result
        if isinstance(obj, dict):
            return {
                "isDirectory": bool(obj.get("isDirectory", False)),
                "isFile": bool(obj.get("isFile", False)),
                "size": int(obj.get("size", 0)),
            }
        return {
            "isDirectory": bool(getattr(obj, "isDirectory", False)),
            "isFile": bool(getattr(obj, "isFile", False)),
            "size": int(getattr(obj, "size", 0)),
        }

    async def exists(path):
        result = await _bridge.exists(path)
        return bool(result)

    async def mkdir(path, parents=False):
        # The underlying vfs.mkdir is recursive ({recursive: true} in
        # realm-host.ts), matching parents=True semantics. With
        # parents=False we raise FileExistsError when the target
        # already exists, mirroring pathlib.Path.mkdir(parents=False).
        if not parents:
            try:
                already = await exists(path)
            except Exception:
                already = False
            if already:
                raise FileExistsError(path)
        await _bridge.mkdir(path)

    async def remove(path):
        await _bridge.remove(path)

    async def walk(path):
        results = []
        async def _visit(current):
            names = await listdir(current)
            dirnames = []
            filenames = []
            for name in names:
                child = current + "/" + name if current != "/" else "/" + name
                try:
                    st = await stat(child)
                except Exception:
                    continue
                if st["isDirectory"]:
                    dirnames.append(name)
                elif st["isFile"]:
                    filenames.append(name)
            results.append((current, dirnames, filenames))
            for d in list(dirnames):
                child = current + "/" + d if current != "/" else "/" + d
                await _visit(child)
        await _visit(path)
        return results

    fs_module.listdir = listdir
    fs_module.read_bytes = read_bytes
    fs_module.read_text = read_text
    fs_module.write_bytes = write_bytes
    fs_module.write_text = write_text
    fs_module.stat = stat
    fs_module.exists = exists
    fs_module.mkdir = mkdir
    fs_module.remove = remove
    fs_module.walk = walk

    slicc_module = types.ModuleType("slicc")
    slicc_module.fs = fs_module
    sys.modules["slicc"] = slicc_module
    sys.modules["slicc.fs"] = fs_module
    return slicc_module

import _slicc_fs_js as _bridge
_build_slicc_module(_bridge)
del _build_slicc_module
del _bridge
`;

export async function registerSliccFsModule(
  pyodide: PyodideInterface,
  rpc: RealmRpcClient
): Promise<void> {
  const bridge = createSliccFsBridge(rpc);
  pyodide.registerJsModule('_slicc_fs_js', bridge);
  await pyodide.runPythonAsync(PYTHON_SLICC_WRAPPER);
}
