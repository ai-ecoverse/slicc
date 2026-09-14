export function compileWasmModule(bytes: Uint8Array): Promise<WebAssembly.Module> {
  return WebAssembly.compile(bytes as unknown as BufferSource);
}

export async function compileWasmFromVfs(
  readBytes: (path: string) => Promise<Uint8Array>,
  path: string
): Promise<WebAssembly.Module> {
  return compileWasmModule(await readBytes(path));
}
