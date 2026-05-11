# @slicc/shared-ts

Platform-agnostic primitives shared across `@slicc/webapp`, `@slicc/node-server`, and `@slicc/chrome-extension`.

## Contents

- `secret-masking.ts` — HMAC-SHA256 masking, domain matching, scrubbing.
- `secrets-pipeline.ts` — stateful unmask/scrub class; Basic-auth-aware, URL-credential-aware, byte-safe body unmask.

## Conventions

- Pure functions only (no DOM / Node specifics). Uses `crypto.subtle`, `TextEncoder`, `Headers` (globals in both targets).
- `SecretsPipeline.unmaskHeaders` mutates its input parameter in place — matches `SecretProxyManager`'s legacy semantics so existing CLI callers compile unchanged.
- Build: `npm run build -w @slicc/shared-ts` (must run before `@slicc/node-server` build in the chain — wired into root `build` script).
- LSP/IDE: uses `tsconfig.json` (noEmit, includes src + tests). Build uses `tsconfig.build.json` (rootDir=src, emits to dist).

## Cross-implementation parity

The Swift counterpart of `SecretsPipeline` lives in `packages/swift-server/Sources/Keychain/SecretInjector.swift` (the class is named `SecretInjector` for historical reasons; it owns the same Basic-auth / URL-creds / byte-safe helpers and the OAuth replica chain). Both implementations are pinned to identical mask outputs via `packages/swift-server/Tests/CrossImplementationTests.swift` and `packages/shared-ts/tests/cross-impl-vectors.test.ts`.

## Naming

The `-ts` suffix is intentional: this package is the TypeScript half of the shared primitives. The Swift half currently lives inside `packages/swift-server/` for build-system convenience; if/when it's promoted to a standalone SPM package consumable from both `swift-server` and `swift-launcher`, the natural home is `packages/shared-swift/` so the two halves sit side-by-side in the file tree.
