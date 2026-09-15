#!/usr/bin/env node
/** Run the heavy VFS reload tests against native OPFS in an isolated Chrome worker. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = await mkdtemp(join(tmpdir(), 'slicc-opfs-tests-'));
// The heavy file uses only these assertions. Unknown assertions throw normally;
// the runner executes the original test bodies, sequentially in a fresh origin.
const assertions = `
const tests = [];
export const describe = Object.assign((_name, body) => body(), { skip() {} });
export function it(name, body) { tests.push({ name, body }); }
export function expect(actual) {
  return {
    toBe(expected) { if (!Object.is(actual, expected)) throw Error('Expected '+JSON.stringify(expected)+'; got '+JSON.stringify(actual)); },
    not: { toBe(expected) { if (Object.is(actual, expected)) throw Error('Unexpected '+JSON.stringify(actual)); } },
    toBeTruthy() { if (!actual) throw Error('Expected a truthy value'); },
    toBeGreaterThan(expected) { if (!(actual > expected)) throw Error('Expected a value greater than '+expected); }
  };
}
export async function run() {
  const results = [];
  for (const test of tests) {
    try { await test.body(); results.push({ name: test.name, passed: true }); }
    catch (error) { results.push({ name: test.name, passed: false, error: String(error?.stack ?? error) }); }
  }
  return results;
}`;
let browser;
let server;
try {
  await build({
    stdin: {
      contents: `import { run } from 'vitest';
        import ${JSON.stringify(join(root, 'packages/webapp/tests/fs/zenfs-reload.heavy.test.ts'))};
        self.onmessage = async () => self.postMessage(await run());`,
      resolveDir: root,
      sourcefile: 'opfs-tests-entry.js',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    external: ['node:fs', 'node:crypto'],
    alias: {
      'node:zlib': join(root, 'packages/webapp/src/shims/empty.ts'),
      'node:module': join(root, 'packages/webapp/src/shims/empty.ts'),
      '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js': join(
        root,
        'node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js'
      ),
    },
    define: {
      'process.env.SLICC_TEST_HEAVY_OPFS': '"1"',
      __DEV__: 'false',
      __SLICC_VERSION__: '"opfs-test"',
    },
    plugins: [
      {
        name: 'heavy-test-assertions',
        setup(builder) {
          builder.onResolve({ filter: /^vitest$/ }, () => ({
            path: 'vitest',
            namespace: 'assertions',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'assertions' }, () => ({
            contents: assertions,
            loader: 'js',
          }));
        },
      },
    ],
    outfile: join(temporary, 'worker.js'),
    logLevel: 'silent',
  });
  const worker = await readFile(join(temporary, 'worker.js'));
  server = createServer((request, response) => {
    if (request.url === '/worker.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(worker);
    } else if (request.url === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>SLICC OPFS tests</title>');
    } else response.writeHead(404).end();
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const results = await page.evaluate(
    () =>
      new Promise((done, reject) => {
        const worker = new Worker('/worker.js', { type: 'module' });
        const timer = setTimeout(() => {
          worker.terminate();
          reject(Error('OPFS tests exceeded 120 seconds'));
        }, 120_000);
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          worker.terminate();
          done(data);
        };
        worker.onerror = (error) => {
          clearTimeout(timer);
          worker.terminate();
          reject(Error(error.message || 'OPFS worker failed to load'));
        };
        worker.postMessage(null);
      })
  );
  console.log(JSON.stringify({ browser: browser.version(), results }, null, 2));
  if (results.length === 0 || results.some((result) => !result.passed)) process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
