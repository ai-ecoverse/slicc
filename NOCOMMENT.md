# Comment-stripped vs main — competing PRs

Same Grok 4.6 prompt, two trees: `main` (comments intact) vs this branch
(comments stripped). PRs against `no-comment` use `Related to`, not `Closes`.

| Task                                                                  | main PR                                                 | no-comment PR                                           | Faster | Smaller | Notes                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- | ------ | ------- | ----------------------------------------------- |
| [#3155](https://github.com/ai-ecoverse/slicc/issues/3155) `exitCode`  | [#3161](https://github.com/ai-ecoverse/slicc/pull/3161) | [#3159](https://github.com/ai-ecoverse/slicc/pull/3159) | nc     | nc      | Same bug. Main extra files are comments/docs.   |
| [#3156](https://github.com/ai-ecoverse/slicc/issues/3156) `cwd`/`env` | [#3168](https://github.com/ai-ecoverse/slicc/pull/3168) | [#3163](https://github.com/ai-ecoverse/slicc/pull/3163) | nc     | nc      | Same. nc one commit.                            |
| [#3149](https://github.com/ai-ecoverse/slicc/issues/3149) TS ratchet  | [#3167](https://github.com/ai-ecoverse/slicc/pull/3167) | [#3162](https://github.com/ai-ecoverse/slicc/pull/3162) | main   | nc      | Policy. nc wandered (~86 min). Prefer main.     |
| [#3149](https://github.com/ai-ecoverse/slicc/issues/3149) Swift gate  | [#3164](https://github.com/ai-ecoverse/slicc/pull/3164) | [#3160](https://github.com/ai-ecoverse/slicc/pull/3160) | nc     | nc      | Main is the real gate (more forbidden modules). |

Comments help when inventing a policy. They look like drag on a measured
runtime lie (`exitCode`, `cwd`). CI on this branch is 3–4 jobs; `main` is ~36.

Desk `thr_dp6wsdxtsj`, 2026-09-16.
