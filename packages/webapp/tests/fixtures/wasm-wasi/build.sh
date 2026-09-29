#!/usr/bin/env bash



set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
zig cc -target wasm32-wasi -Os -s "$HERE/wasitest.c" -o "$HERE/wasitest.wasm"
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
