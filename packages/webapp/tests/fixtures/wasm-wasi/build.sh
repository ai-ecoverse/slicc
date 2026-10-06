#!/usr/bin/env bash



set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
zig cc -target wasm32-wasi -Os -s "$HERE/wasitest.c" -o "$HERE/wasitest.wasm"
zig cc -target wasm32-wasi -Os -s "$HERE/wasisock.c" -o "$HERE/wasisock.wasm"
zig cc -target wasm32-wasi -Os -s "$HERE/probetest.c" -o "$HERE/probetest.wasm"
zig build-exe "$HERE/zigtest.zig" -target wasm32-wasi -O ReleaseSmall -fstrip \
  -femit-bin="$HERE/zigtest.wasm"
rm -f "$HERE/zigtest.wasm.o"
ls -la "$HERE"/*.wasm


TOOLCHAIN="${SLICC_EMSCRIPTEN:-$HOME/Developer/ai-ecoverse/slicc-emscripten}"
OUT="${WASITEST_BUILD:-$TOOLCHAIN/build/wasm-wasi}"
export EM_CONFIG="$TOOLCHAIN/emscripten-config" EM_CACHE="${EM_CACHE:-$OUT/cache}"
export EMSDK_PYTHON="${EMSDK_PYTHON:-/opt/homebrew/bin/python3.13}"
mkdir -p "$OUT"
[ -d "$EM_CACHE" ] || cp -R "$TOOLCHAIN/cache" "$EM_CACHE"
"$TOOLCHAIN/src/emscripten/emcc" -Os "$HERE/wasitest.c" -o "$OUT/wasitest-em.js" \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node
cp "$OUT/wasitest-em.js" "$HERE/wasitest-em"
cp "$OUT/wasitest-em.wasm" "$HERE/wasitest-em.wasm"
ls -la "$HERE/wasitest-em" "$HERE/wasitest-em.wasm"



WASIX_SYSROOT="${WASIX_SYSROOT:-$TOOLCHAIN/tmp-wasi/wasix/sysroot/wasix-sysroot/sysroot}"
RES="$OUT/wasix-resource-dir"
rm -rf "$RES" && mkdir -p "$RES/lib/wasm32-unknown-wasi"
ln -s "$("$TOOLCHAIN/install/bin/clang" -print-resource-dir)/include" "$RES/include"
ln -s "$WASIX_SYSROOT/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a" \
  "$RES/lib/wasm32-unknown-wasi/libclang_rt.builtins.a"
"$TOOLCHAIN/install/bin/clang" --target=wasm32-wasi --sysroot="$WASIX_SYSROOT" -resource-dir "$RES" \
  -O2 -Wno-deprecated -D_WASI_EMULATED_PROCESS_CLOCKS -matomics -mbulk-memory -mmutable-globals \
  -pthread -mthread-model posix -ftls-model=local-exec \
  -Wl,--shared-memory -Wl,--import-memory -Wl,--max-memory=4294967296 \
  -Wl,--export=__data_end -Wl,--export=__heap_base -Wl,--export=__stack_pointer \
  -Wl,--export-if-defined=__tls_base -Wl,--export-if-defined=__wasm_init_tls \
  -Wl,--export-if-defined=__wasm_signal -Wl,--export-if-defined=wasi_thread_start \
  -o "$OUT/wasixtest.wasm" "$HERE/wasixtest.c" -lwasi-emulated-process-clocks
wasm-opt --asyncify -O2 --enable-threads --enable-bulk-memory --enable-mutable-globals \
  --enable-sign-ext --enable-nontrapping-float-to-int "$OUT/wasixtest.wasm" -o "$HERE/wasixtest.wasm"
ls -la "$HERE/wasixtest.wasm"


(cd "$HERE/threadtest-rs" && cargo build --release --target wasm32-wasip1-threads)
cp "${CARGO_TARGET_DIR:-$HERE/threadtest-rs/target}/wasm32-wasip1-threads/release/threadtest.wasm" "$HERE/threadtest.wasm"
ls -la "$HERE/threadtest.wasm"
