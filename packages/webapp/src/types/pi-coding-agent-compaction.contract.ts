/**
 * Compile-time positional contract for `generateSummary` from
 * `@mariozechner/pi-coding-agent`.
 *
 * pi-coding-agent 0.63.0 (renovate bump 637c4f17, 2026-03-27) inserted
 * `headers?: Record<string, string>` at slot 4 of `generateSummary`,
 * shifting `signal?: AbortSignal` to slot 5. The local ambient stub at
 * `pi-coding-agent-compaction.d.ts` was originally written against 0.57
 * and silently kept `signal?` at slot 4 — so our positional caller in
 * `core/context-compaction.ts` passed the AbortSignal into the new
 * `headers` slot and the Adobe LLM proxy lost `X-Session-Id` for every
 * compaction summary. The bug was only caught weeks later via proxy
 * telemetry (commit a78968dc).
 *
 * This file is a tripwire on the slot positions that carry semantic load
 * for the Adobe proxy contract:
 *
 *   slot 4: headers ──── must accept `Record<string, string>`
 *   slot 5: signal  ──── must accept `AbortSignal`
 *
 * Scope (be honest about it):
 *
 *   - Catches: a future stub edit that swaps these slots back, or a
 *     renovate-bump-plus-stub-update PR that gets the new shape wrong.
 *   - Does NOT catch: a renovate bump that ships without any stub edit.
 *     The local ambient `declare module` shadows upstream resolution
 *     under `moduleResolution: bundler`, so tsc never reads upstream's
 *     real `.d.ts`. Catching that class of drift would require either an
 *     upstream PR exposing `./dist/*` in the package's exports map (so
 *     we can drop the stub), or a tsconfig `paths` mapping that bypasses
 *     the exports map (which surfaces unrelated pre-existing type
 *     tensions in scoop-context.ts and core/session.ts — out of scope
 *     for this commit).
 *
 * The file emits no runtime code worth keeping; the `void _checkN`
 * lines exist purely to anchor the assertions in a value position so
 * tsc has something to fail on if the contract breaks.
 */

import type { generateSummary } from '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js';

type Params = Parameters<typeof generateSummary>;

// If slot 4 stops accepting `Record<string, string>`, the conditional
// resolves to `never` and the assignment below fails to compile.
type _Slot4HeadersContract = Params[4] extends Record<string, string> | undefined ? true : never;

// If `signal?` slides back to slot 4 (or any other shape lands at slot 5),
// this assignment fails to compile.
type _Slot5SignalContract = Params[5] extends AbortSignal | undefined ? true : never;

const _slot4Check: _Slot4HeadersContract = true;
const _slot5Check: _Slot5SignalContract = true;
void _slot4Check;
void _slot5Check;
