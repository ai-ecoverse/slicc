#!/usr/bin/env bash




set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLCHAIN="${SLICC_EMSCRIPTEN:-$HOME/Developer/ai-ecoverse/slicc-emscripten}"
SYSROOT="${WASIX_PIC_SYSROOT:-$TOOLCHAIN/tmp-wasi/py-contract/ehpic/wasix-sysroot-ehpic/sysroot}"
CC="$TOOLCHAIN/install/bin/clang"
LD="$TOOLCHAIN/install/bin/wasm-ld"
CFLAGS=(--target=wasm32-wasi "--sysroot=$SYSROOT" -O2 -fPIC -matomics -mbulk-memory
  -mmutable-globals -pthread -mthread-model posix -ftls-model=local-exec
  -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN)
FEATURES=--extra-features=atomics,bulk-memory,mutable-globals
OUT="$(mktemp -d)"

printf "__c_longjmp\n__cpp_exception\n" > "$OUT/tags.txt"
for lib in liba libb; do
  "$CC" "${CFLAGS[@]}" -fvisibility=default -c "$HERE/$lib.c" -o "$OUT/$lib.o"
done
"$LD" "$FEATURES" --export=__wasm_call_ctors --export-if-defined=__wasm_apply_data_relocs \
  --experimental-pic --unresolved-symbols=import-dynamic -shared --shared-memory \
  -o "$HERE/liba.so" "$OUT/liba.o"
"$LD" "$FEATURES" --export=__wasm_call_ctors --export-if-defined=__wasm_apply_data_relocs \
  --experimental-pic --unresolved-symbols=import-dynamic -shared --shared-memory \
  "-L$HERE" -la -o "$HERE/libb.so" "$OUT/libb.o"


"$CC" "${CFLAGS[@]}" -fvisibility=default -c "$HERE/librun.c" -o "$OUT/librun.o"
"$LD" "$FEATURES" --export=__wasm_call_ctors --export-if-defined=__wasm_apply_data_relocs \
  --experimental-pic --unresolved-symbols=import-dynamic -shared --shared-memory \
  "-L$HERE" -la --rpath=/no/such/dir '--rpath=$ORIGIN/../deps' -o "$HERE/librun.so" "$OUT/librun.o"
"$CC" "${CFLAGS[@]}" -c "$HERE/dlmain.c" -o "$OUT/dlmain.o"


"$LD" "-L$SYSROOT/lib" "-L$SYSROOT/lib/wasm32-wasi" --export-all \
  "$OUT/dlmain.o" "$SYSROOT/lib/wasm32-wasi/crt1.o" -lc -lresolv -lrt -lm -lpthread \
  -lwasi-emulated-process-clocks -lwasi-emulated-mman \
  "$SYSROOT/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a" \
  --import-memory --shared-memory --max-memory=4294967296 "$FEATURES" \
  --export=__wasm_signal --export=__tls_size --export=__tls_align --export=__tls_base \
  --export=__wasm_call_ctors --export-if-defined=__wasm_apply_data_relocs \
  "--allow-undefined-file=$OUT/tags.txt" --experimental-pic -pie -o "$HERE/dlmain.wasm"




"$TOOLCHAIN/install/bin/clang++" "${CFLAGS[@]}" -fwasm-exceptions -c "$HERE/weakmain.cpp" -o "$OUT/weakmain.o"
"$LD" "-L$SYSROOT/lib" "-L$SYSROOT/lib/wasm32-wasi" --export-all \
  "$OUT/weakmain.o" "$SYSROOT/lib/wasm32-wasi/crt1.o" -lc++ -lc++abi -lunwind -lc -lresolv -lrt -lm -lpthread \
  -lwasi-emulated-process-clocks -lwasi-emulated-mman \
  "$SYSROOT/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a" \
  --import-memory --shared-memory --max-memory=4294967296 "$FEATURES" \
  --export=__wasm_signal --export=__tls_size --export=__tls_align --export=__tls_base \
  --export=__wasm_call_ctors --export-if-defined=__wasm_apply_data_relocs \
  "--allow-undefined-file=$OUT/tags.txt" --unresolved-symbols=import-dynamic \
  --experimental-pic -pie -o "$OUT/weakmain.wasm"
"$TOOLCHAIN/install/bin/llvm-strip" --strip-all --keep-section=dylink.0 \
  -o "$HERE/weakmain.wasm" "$OUT/weakmain.wasm"
ls -la "$HERE"/*.so "$HERE"/dlmain.wasm "$HERE"/weakmain.wasm
