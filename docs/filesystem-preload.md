# Optional OPFS preload

`VirtualFS.create({ backend: 'opfs', opfsAsyncCache: false })` passes ZenFS's
`disableAsyncCache` option to the OPFS backend. It skips the eager file-content
copy into the synchronous cache. The production default is unchanged.

This is an experiment for large trees: the September 2026 audit's isolated
30,000-file workload mounted in 7.709 seconds with preload and 3.482 seconds
without it on the tested machine. These are measurements of that fixture, not a
SLICC boot-time guarantee. Sidecar validation and repair still scan metadata.
The option was already available before the current ZenFS pin; it is an optional
API adoption, not a newly released feature or a dependency upgrade.

## Contract

- Async VFS operations keep using the same OPFS tree and metadata sidecar.
- `statSync`, `lstatSync`, and `readDirSync` return `null` when the backend cannot
  serve them. Consumers must use their existing asynchronous fallback. This can
  trade faster mounting and lower cache memory for slower repeated reads.
- Same-database instances share the first opener's setting when they omit it.
  Explicitly conflicting settings fail with `EBUSY`; initialization is serialized
  per database so simultaneous callers cannot choose different modes.
- Dispose all instances before changing modes. Reopening with the default cache
  reads the same persisted data. The memory backend ignores this option.
- No UI, environment variable, or runtime default enables the experiment.

## Native browser verification

```sh
npm ci
npx playwright install chromium
npm run test:opfs
```

The harness launches a separate headless Chromium, serves only its generated
worker on an ephemeral loopback port, and executes the original heavy reload
test bodies against native OPFS. It prints JSON results and exits nonzero if any
test fails or no tests run. It closes its browser/server and removes its temporary
bundle. It does not attach to an existing SLICC or browser session.

For an existing Chrome for Testing installation, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path. The harness has a small
assertion adapter for the heavy test file's supported matchers; it does not run
the full UI or replace Vitest coverage. `npm test` additionally exercises both
cache modes and concurrent configuration conflicts with the File System Access
fixture.

## Other optional APIs

ZenFS's `bindContext({ mounts })` can replace global mount-prefix bookkeeping,
but the current pinned implementation retains every bound context in an internal
global registry and exposes no public disposal method. SLICC frequently creates
and disposes VFS instances, so changing that lifecycle needs a separate design
and leak test. This experiment keeps the existing mount lifecycle.

The DOM dependency update and preload-concurrency API are already handled by
[PR #3103](https://github.com/ai-ecoverse/slicc/pull/3103). This option is compatible
with that direction: concurrency limits matter when preload is enabled; disabling
preload avoids the content copy entirely. The existing sidecar repair and upstream
patches remain necessary.
