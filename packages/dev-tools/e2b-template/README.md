# SLICC e2b template

Container image that runs `node-server --hosted` + headless Chromium. Used by
the `slicc --cloud` CLI. node-server is a thin /cdp bridge + /api surface in
every mode, so the headless Chromium loads the webapp from the hosted origin
(sliccy.ai) — no webapp bundle is baked into the image.

## Build

Requires the e2b CLI authenticated to the right team. From the repo root,
after `npm run build` has produced `dist/node-server`:

    packages/dev-tools/e2b-template/scripts/build-template.sh

The script tags the published template with the SLICC version from the root
`package.json`.

## Isolated / test builds (don't override production)

e2b has no build-without-deploy mode — `Template.build` builds on e2b's infra
and registers the result under an alias, consuming build credits. To build
without touching the live template, publish under a **different alias** (not a
`slicc:tag` — a tag attaches a build to the live `slicc` template):

    SLICC_E2B_TEMPLATE_NAME=slicc-test \
      packages/dev-tools/e2b-template/scripts/build-template.sh

`SLICC_E2B_TEMPLATE_NAME` defaults to `slicc`. Production template resolution is
unaffected: the worker + CLI boot `slicc` by default (`cloud-core`
`operations/start.ts`), so a `slicc-test` build never changes what
`Sandbox.create('slicc')` sees. The sandbox `list` filter matches the `slicc`
**prefix** (`isSliccTemplate` in `cloud-core` `substrates/e2b.ts`), so cones
booted from a `slicc-test` alias do show up in `--cloud list` (by design — that
is how you manage and kill them, rather than them appearing `dead`).
`verify-template.sh` honors the same env var, so it boots the alias you built.

## Verify

    SLICC_TEST_E2B_API_KEY=... packages/dev-tools/e2b-template/scripts/verify-template.sh

Creates one sandbox, polls `/tmp/slicc-join.json`, kills the sandbox.

## Which CI workflow builds which alias

`Template.build` always publishes (e2b has no build-without-deploy), so the
alias a workflow builds is what its consumers see. The split:

- **`release.yml`** (push to `main`, i.e. merge) and **`worker.yml`** (manual
  prod deploy) build the production **`slicc`** alias via `publish-worker.sh`.
  This is the real release — `Sandbox.create('slicc')` should serve merged code.
- **`worker-staging.yml`** runs on **every PR** touching `cloudflare-worker/` or
  `cloud-core/`, so it MUST NOT build `slicc` — that would republish prod from
  un-merged branch code. It sets `SLICC_E2B_TEMPLATE_NAME=slicc-staging` on both
  the build and verify steps, so it validates "this PR's template builds &
  boots" under the isolated **`slicc-staging`** alias (overwritten each run; no
  per-PR sprawl). Prod `slicc` is untouched.

## Notes

- Not an npm workspace. Invoke the scripts directly.
- Chromium is pinned to the version in the base image's apt repositories at
  build time. Updating Chromium requires a template rebuild.
- The node-server binaries are copied from `dist/` produced by the monorepo's
  root `npm run build`. Always build before publishing the template. The webapp
  is not bundled — the hosted Chromium loads it from the hosted origin.
