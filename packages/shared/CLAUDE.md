# @slicc/shared

Platform-agnostic primitives shared across `@slicc/webapp`, `@slicc/node-server`, and `@slicc/chrome-extension`.

## Contents

- `secret-masking.ts` — HMAC-SHA256 masking, domain matching, scrubbing.
- `secrets-pipeline.ts` — stateful unmask/scrub class; Basic-auth-aware, URL-credential-aware, byte-safe body unmask.

## Conventions

- Pure functions only (no DOM / Node specifics). Uses `crypto.subtle`, `TextEncoder`, `Headers` (globals in both targets).
- `SecretsPipeline.unmaskHeaders` mutates its input parameter in place — matches `SecretProxyManager`'s legacy semantics so existing CLI callers compile unchanged.
- Build: `npm run build -w @slicc/shared` (must run before `@slicc/node-server` build in the chain — wired into root `build` script).
- LSP/IDE: uses `tsconfig.json` (noEmit, includes src + tests). Build uses `tsconfig.build.json` (rootDir=src, emits to dist).

## Cross-implementation parity

A Swift port of `SecretsPipeline` lives in `packages/swift-server/Sources/Keychain/SecretsPipeline.swift`. Both implementations are pinned to identical mask outputs via `tests/CrossImplementationTests.swift` (Swift) and `tests/cross-impl-vectors.test.ts` (TS).
