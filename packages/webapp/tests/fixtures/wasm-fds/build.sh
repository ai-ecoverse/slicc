#!/usr/bin/env bash
# Rebuild the fdtest fixture (glue `fdtest` + `fdtest.wasm`) with the SLICC
# Emscripten toolchain and its shims: slicc_spawn.c (posix_spawn / waitpid
# over the wasm-realm kernel), slicc_socket.c and slicc_select.c (sockets). The toolchain lives outside this repo: set
# SLICC_EMSCRIPTEN to its checkout.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLCHAIN="${SLICC_EMSCRIPTEN:-$HOME/Developer/ai-ecoverse/slicc-emscripten}"
EM="$TOOLCHAIN/src/emscripten"
OUT="${FDTEST_BUILD:-$TOOLCHAIN/build/wasm-fds}"
export EM_CONFIG="$TOOLCHAIN/emscripten-config" EM_CACHE="${EM_CACHE:-$OUT/cache}"
export EMSDK_PYTHON="${EMSDK_PYTHON:-/opt/homebrew/bin/python3.13}"
mkdir -p "$OUT"
# A private cache (seeded from the toolchain's) so concurrent builds never share one.
[ -d "$EM_CACHE" ] || cp -R "$TOOLCHAIN/cache" "$EM_CACHE"
for shim in slicc_spawn slicc_socket slicc_select; do
  "$EM/emcc" -O2 -c "$TOOLCHAIN/slicc/lib/$shim.c" -o "$OUT/$shim.o"
done
"$EM/emcc" -O2 "$HERE/fdtest.c" "$OUT/slicc_spawn.o" "$OUT/slicc_socket.o" "$OUT/slicc_select.o" \
  -o "$OUT/fdtest.js" \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node
# Extensionless glue, as a package installs it (`bin/<x>` + `bin/<x>.wasm`).
cp "$OUT/fdtest.js" "$HERE/fdtest"
cp "$OUT/fdtest.wasm" "$HERE/fdtest.wasm"
ls -la "$HERE/fdtest" "$HERE/fdtest.wasm"
