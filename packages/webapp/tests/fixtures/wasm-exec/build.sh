#!/usr/bin/env bash






set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLCHAIN="${SLICC_EMSCRIPTEN:-$HOME/Developer/ai-ecoverse/slicc-emscripten}"
EM="$TOOLCHAIN/src/emscripten"
OUT="${PROCTEST_BUILD:-$TOOLCHAIN/build/wasm-exec}"
export EM_CONFIG="$TOOLCHAIN/emscripten-config" EM_CACHE="${EM_CACHE:-$OUT/cache}"
export EMSDK_PYTHON="${EMSDK_PYTHON:-/opt/homebrew/bin/python3.13}"
mkdir -p "$OUT"

[ -d "$EM_CACHE" ] || cp -R "$TOOLCHAIN/cache" "$EM_CACHE"
SHIMS=(slicc_spawn slicc_exec slicc_fork slicc_jobs slicc_socket slicc_select slicc_libc_gaps)
for shim in "${SHIMS[@]}"; do
  "$EM/emcc" -O2 -c "$TOOLCHAIN/slicc/lib/$shim.c" -o "$OUT/$shim.o"
done
"$EM/emcc" -O2 "$HERE/proctest.c" $(printf "$OUT/%s.o " "${SHIMS[@]}") \
  --js-library "$TOOLCHAIN/slicc/lib/slicc-fork.js" -sASYNCIFY -sASYNCIFY_STACK_SIZE=65536 \
  -o "$OUT/proctest.js" \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,sliccRunMain,sliccForkChild -sENVIRONMENT=web,worker,node

cp "$OUT/proctest.js" "$HERE/proctest"
cp "$OUT/proctest.wasm" "$HERE/proctest.wasm"
ls -la "$HERE/proctest" "$HERE/proctest.wasm"
