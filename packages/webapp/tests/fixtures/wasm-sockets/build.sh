#!/usr/bin/env bash
# Rebuild the socktest fixture (glue `socktest` + `socktest.wasm`) with the
# SLICC Emscripten toolchain and its libc shims (slicc_socket.c for sockets,
# slicc_select.c for poll/select). The toolchain lives outside this repo:
# set SLICC_EMSCRIPTEN to its checkout.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLCHAIN="${SLICC_EMSCRIPTEN:-$HOME/Developer/ai-ecoverse/slicc-emscripten}"
EM="$TOOLCHAIN/src/emscripten"
OUT="${SOCKTEST_BUILD:-$TOOLCHAIN/build/loopback-3571}"
export EM_CONFIG="$TOOLCHAIN/emscripten-config" EM_CACHE="${EM_CACHE:-$OUT/cache}"
export EMSDK_PYTHON="${EMSDK_PYTHON:-/opt/homebrew/bin/python3.13}"
mkdir -p "$OUT"
# A private cache (seeded from the toolchain's) so concurrent builds never share one.
[ -d "$EM_CACHE" ] || cp -R "$TOOLCHAIN/cache" "$EM_CACHE"
for shim in slicc_socket slicc_select; do
  "$EM/emcc" -O2 -c "$TOOLCHAIN/slicc/lib/$shim.c" -o "$OUT/$shim.o"
done
"$EM/emcc" -O2 "$HERE/socktest.c" "$OUT/slicc_socket.o" "$OUT/slicc_select.o" -o "$OUT/socktest.js" \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node
# Extensionless glue, as a package installs it (`bin/<x>` + `bin/<x>.wasm`).
cp "$OUT/socktest.js" "$HERE/socktest"
cp "$OUT/socktest.wasm" "$HERE/socktest.wasm"
ls -la "$HERE/socktest" "$HERE/socktest.wasm"
