# Comment-stripped vs `main` — competing PRs

Same Grok 4.6 prompt, two trees: `main` (comments and docs intact) vs this branch (comments/docs stripped). PRs against `no-comment` use `Related to #…`, not `Closes`, so they do not close GitHub issues off the default branch.

| Task | `main` PR | `no-comment` PR | Faster | Smaller diff | Notes |
|---|---|---|---|---|---|
| [#3155](https://github.com/ai-ecoverse/slicc/issues/3155) `process.exitCode` ignored | [#3161](https://github.com/ai-ecoverse/slicc/pull/3161) `thr_jjvkcwmmbq` +215/−36, 11 files, ~25 min | [#3159](https://github.com/ai-ecoverse/slicc/pull/3159) `thr_a695ekien6` +141/−3, 5 files, ~18 min | no-comment | no-comment | Same shim bug. Main extra files are mostly comments/docs/tests around it. nc skipped full `verify` (pre-existing strip noise). |
| [#3156](https://github.com/ai-ecoverse/slicc/issues/3156) `spawnSync` cwd/env ignored | [#3168](https://github.com/ai-ecoverse/slicc/pull/3168) `thr_avkwtw7a9s` +623/−28, 17 files, 2 commits, ~37 min | [#3163](https://github.com/ai-ecoverse/slicc/pull/3163) `thr_fkvp6nubbj` +437/−43, 12 files, 1 commit, ~25 min | no-comment | no-comment | Same. nc tighter. |
| [#3149](https://github.com/ai-ecoverse/slicc/issues/3149) TS layer-back-edge ratchet | [#3167](https://github.com/ai-ecoverse/slicc/pull/3167) `thr_cye4hcnrt7` +619/−140, 21 files, ~33 min | [#3162](https://github.com/ai-ecoverse/slicc/pull/3162) `thr_fevv38njwi` +522/−76, 7 files, ~86 min | **main** | no-comment | Policy task. nc wandered. Prefer main. |
| [#3149](https://github.com/ai-ecoverse/slicc/issues/3149) Swift widget import gate | [#3164](https://github.com/ai-ecoverse/slicc/pull/3164) `thr_fqyg6p6ud8` +961/−23, 18 files, 2 commits, ~32 min | [#3160](https://github.com/ai-ecoverse/slicc/pull/3160) `thr_ebq3jw3mik` +330/−7, 4 files, ~16 min | no-comment | no-comment | **main is the real gate** (WebRTC + TrayFollower/VFS/TrayKit/UIKit/AppKit). nc forbids WebRTC only. |

## Read

Comments help when the agent is **inventing a policy** (layer stacks, what widgets must not import). They look like drag on a **measured one-line runtime lie** (`exitCode`, `cwd`).

“Faster to green” on this branch is not the same bar as `main`: CI here is 3–4 jobs, `main` is ~36. `npm run verify` on no-comment still fails on pre-existing stripped-docs / biome issues.

Spawned 2026-09-16 from desk `thr_dp6wsdxtsj`.
