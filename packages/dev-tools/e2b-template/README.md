# SLICC e2b template

Container image that runs `node-server --hosted` + headless Chromium + the
bundled webapp. Used by the `slicc --cloud` CLI.

## Build

Requires the e2b CLI authenticated to the right team. From the repo root,
after `npm run build` has produced `dist/node-server` and `dist/ui`:

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

`SLICC_E2B_TEMPLATE_NAME` defaults to `slicc`. Production is unaffected because
the worker + CLI resolve `slicc` by default (`cloud-core` `operations/start.ts`)
and the sandbox `list` filter only matches `name === 'slicc'`
(`cloud-core` `substrates/e2b.ts`). `verify-template.sh` honors the same env var,
so it boots the alias you just built.

## Verify

    SLICC_TEST_E2B_API_KEY=... packages/dev-tools/e2b-template/scripts/verify-template.sh

Creates one sandbox, polls `/tmp/slicc-join.json`, kills the sandbox.

## Skipping the build (temporary)

Set `SLICC_SKIP_E2B_TEMPLATE=1` to make both `build-template.sh` and
`verify-template.sh` no-op (print a notice and `exit 0`). This is a temporary
escape hatch for the release pipeline while the e2b team account is out of build
credits: it lets a release deploy the worker against the already-published
template instead of failing on `Template.build`. Remove the
`SLICC_SKIP_E2B_TEMPLATE` env from `.github/workflows/release.yml` (and this
note) once credits are restored.

## Notes

- Not an npm workspace. Invoke the scripts directly.
- Chromium is pinned to the version in the base image's apt repositories at
  build time. Updating Chromium requires a template rebuild.
- The webapp + node-server binaries are copied from `dist/` produced by the
  monorepo's root `npm run build`. Always build before publishing the template.
