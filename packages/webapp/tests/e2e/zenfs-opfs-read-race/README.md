# ZenFS OPFS File snapshot reproduction

Upstream report with the full inline example: [zen-fs/dom#46](https://github.com/zen-fs/dom/issues/46).

This fixture uses one six-byte native OPFS file, `zenfs-one-file-race/race.txt`.
It commits an overwrite after ZenFS obtains a File snapshot and before it reads
the bytes. The hooks control scheduling; native Chromium supplies the File and
throws the error. No fake exception or file object is involved.

Run from the repository root after `npm ci` to test the installed patches:

```sh
mkdir -p /tmp/zenfs-snapshot-test
npx esbuild packages/webapp/tests/e2e/zenfs-opfs-read-race/worker.js --bundle --format=esm --platform=browser --outfile=/tmp/zenfs-snapshot-test/bundle.js
cp packages/webapp/tests/e2e/zenfs-opfs-read-race/index.html /tmp/zenfs-snapshot-test/index.html
python3 -m http.server 8080 --bind 127.0.0.1 --directory /tmp/zenfs-snapshot-test
```

Open `http://127.0.0.1:8080` in a fresh Chrome for Testing profile. Reload to repeat.
Change `always: false` to `always: true` in the served HTML to invalidate every
snapshot, including retries. The page terminates its worker after each result.

To test unmodified upstream packages, copy `worker.js` and `index.html` into an
empty directory, install core 2.7.2 / dom 1.2.13 / esbuild 0.28.2 there, and bundle
`worker.js` to `bundle.js` before serving that directory.

On Chrome 151.0.7922.34, macOS 26.5.2 arm64, upstream dom 1.2.13 / core 2.7.2
failed all three once-overwrite runs with native `NotReadableError`. Dom 1.2.12 /
core 2.6.5 failed 20/20. With the snapshot-read patch, all 20 once-overwrite runs
succeeded and the synchronous cache contained `after!`; all 20 always-overwrite
runs still failed, after exactly three attempts. Both versions of the file are
six bytes, so this isolates snapshot readability from concurrent size changes.

Unit guards: `npm test -- zenfs-opfs-read-retry`.
