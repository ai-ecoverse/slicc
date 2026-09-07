# ZenFS OPFS preload reproduction

Upstream report with the full inline example: [zen-fs/core#318](https://github.com/zen-fs/core/issues/318).

This fixture writes 30,000 one-byte files in its own `zenfs-static-preload` OPFS
directory. Eight seed writers close every stream, then the page terminates the
seed worker and mounts the static tree in a fresh worker. Reload to repeat.

Run from the repository root after `npm ci` to test the installed patches:

```sh
mkdir -p /tmp/zenfs-preload-test
npx esbuild packages/webapp/tests/e2e/zenfs-preload/worker.js --bundle --format=esm --platform=browser --outfile=/tmp/zenfs-preload-test/bundle.js
cp packages/webapp/tests/e2e/zenfs-preload/index.html /tmp/zenfs-preload-test/index.html
python3 -m http.server 8080 --bind 127.0.0.1 --directory /tmp/zenfs-preload-test
```

Open `http://127.0.0.1:8080` in a fresh Chrome for Testing profile. Keep the tab
open while it seeds. The page reports peak active backend reads and the outcome.
To test unmodified upstream packages, copy `worker.js` and `index.html` into an
empty directory, install core 2.7.2 / dom 1.2.13 / esbuild 0.28.2 there, and bundle
`worker.js` to `bundle.js` before serving that directory.

On Chrome 151.0.7922.34, macOS 26.5.2 arm64, unmodified core 2.7.2 / dom 1.2.13
failed 3/3 mounts with native `NotReadableError` and peak concurrency 30,000.
An external 16-read semaphore passed 3/3. The patched core 2.6.5 also limits reads
to 16. The failure threshold depends on the browser and host; 30 KB is the file
payload, not the browser's total memory or metadata usage.

Unit guards: `npm test -- zenfs-preload-concurrency`.
