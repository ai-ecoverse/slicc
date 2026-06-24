/**
 * `wasm-compiler.ts` — shared, host-context WebAssembly compilation
 * primitives. Lives at the kernel-realm layer so BOTH the realm host
 * (`realm-host.ts`'s `wasm` RPC channel) and the shell-side
 * `esbuild-wasm` loader compile through one code path.
 *
 * Why a shared helper: large modules (biome's ~37 MB `biome_wasm_bg.wasm`)
 * hard-OOM `WebAssembly.compile` INSIDE a per-task realm DedicatedWorker,
 * while the long-lived kernel-worker / shell context has the headroom to
 * compile them. Routing compilation here — invoked host-side — keeps the
 * raw bytes and the compiler's working set out of the realm worker; only
 * the resulting `WebAssembly.Module` (structured-cloneable, NOT a
 * transferable) crosses back over the realm port. esbuild already compiled
 * host-side; this consolidates its inline `WebAssembly.compile` onto the
 * same primitive.
 *
 * Intentionally dependency-free so it stays a safe leaf import for both the
 * kernel host and the shell command graph (no layering cycle, no bundle
 * weight).
 */

/**
 * Compile WASM bytes into a `WebAssembly.Module`. Compiles straight from
 * the byte view rather than copying into a fresh `ArrayBuffer` first, so
 * peak memory on a large module stays at ~1x its size instead of ~2x —
 * the headroom that matters when the kernel-worker handles biome's 37 MB
 * binary. The cast sidesteps the `SharedArrayBuffer | ArrayBuffer` union
 * that `Uint8Array`'s backing buffer carries under newer `lib.dom.d.ts`,
 * which `WebAssembly.compile`'s `BufferSource` parameter typing rejects;
 * `compile` honors the view's `byteOffset` / `byteLength`, so passing the
 * view is correct even for a subarray.
 */
export function compileWasmModule(bytes: Uint8Array): Promise<WebAssembly.Module> {
  return WebAssembly.compile(bytes as unknown as BufferSource);
}

/**
 * Read WASM bytes from the VFS via the supplied byte reader and compile
 * them host-side. The reader is `ctx.fs.readFileBuffer` (already resolved)
 * in the realm host; keeping it injected leaves this helper free of any
 * VFS / `CommandContext` dependency so it remains a pure leaf module.
 */
export async function compileWasmFromVfs(
  readBytes: (path: string) => Promise<Uint8Array>,
  path: string
): Promise<WebAssembly.Module> {
  return compileWasmModule(await readBytes(path));
}
