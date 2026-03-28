# TODO

- [x] Create a fresh `handoffs-redux` branch/worktree from `origin/main`
- [x] Add `/handoffs` HTML shell on the Cloudflare worker for fragment-based handoffs
- [x] Add extension tab watching, fragment decoding, pending queue persistence, and badge updates
- [x] Add Chat pending handoff approval modal plus Chat tab badge count
- [x] Add `slicc-handoff` skill/helper and update handoff docs/CLAUDE guidance
- [x] Verify with focused tests, typecheck, and builds

## Review

- Branch reset is isolated in `/Users/amol/Documents/git-repos/ai-ecoverse/slicc-handoffs-redux` so the experimental `handoffs` branch remains untouched.
- Verified helper behavior with `bash -n .agents/skills/slicc-handoff/scripts/slicc-handoff` and `bash .agents/skills/slicc-handoff/scripts/slicc-handoff --help`.
- Verified worker routes with `./node_modules/.bin/vitest run packages/cloudflare-worker/tests/index.test.ts packages/cloudflare-worker/tests/deployed.test.ts`.
- Verified extension queueing with `./node_modules/.bin/vitest run packages/chrome-extension/tests/messages.test.ts packages/chrome-extension/tests/service-worker.test.ts`.
- Verified webapp pending-handoff UI with `./node_modules/.bin/vitest run packages/webapp/tests/ui/offscreen-client.test.ts packages/webapp/tests/ui/tab-zone.test.ts packages/webapp/tests/ui/chat-panel.test.ts`.
- Verified TypeScript with `npm run typecheck -w @slicc/cloudflare-worker`, `npm run typecheck -w @slicc/chrome-extension`, and `npm run typecheck -w @slicc/webapp`.
- Verified production builds with `npm run build -w @slicc/chrome-extension`, `npm run build -w @slicc/webapp`, and `../../node_modules/.bin/wrangler deploy --dry-run --outdir dist` from `packages/cloudflare-worker`.
- Worker dry-run succeeded; Wrangler also emitted its known sandbox log-file `EPERM` warning while trying to write under `/Users/amol/Library/Preferences/.wrangler/logs`.
- Corrected the fragment handoff host to the existing `https://www.sliccy.ai/handoffs#...` worker domain and removed the temporary `.com` route additions.
