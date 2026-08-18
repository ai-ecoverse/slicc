/**
 * E2B v2 template definition for the SLICC hosted leader.
 *
 * Build with:
 *   npm run build                            # produces dist/node-server
 *   bash packages/dev-tools/e2b-template/scripts/build-template.sh
 *
 * That script cd's to the repo root and runs `npx tsx <this file>`.
 * All copy paths below are repo-root-relative.
 *
 * Requires E2B_API_KEY in env, scoped to the team you want to push to.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBuildLogger, Template, waitForFile } from 'e2b';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function main(): Promise<void> {
  // Template alias to publish under. Defaults to the production 'slicc' alias.
  // Override with SLICC_E2B_TEMPLATE_NAME (e.g. 'slicc-test') to build an
  // isolated template that does NOT override what production resolves: the
  // worker + CLI default to 'slicc' (cloud-core start.ts) and the list filter
  // only matches name === 'slicc' (cloud-core substrates/e2b.ts). Use a
  // distinct alias, never a 'slicc:tag' — a tag would attach a build to the
  // live 'slicc' template and could change what Sandbox.create('slicc') sees.
  const templateName = process.env['SLICC_E2B_TEMPLATE_NAME'] ?? 'slicc';

  // Node runtime for the sandbox. The e2bdev/code-interpreter base image ships
  // Node 20 (EOL April 2026, no security patches), while the repo requires
  // engines >= 22.18.0. Install a pinned Node 22 LTS over /usr/local so the
  // `node` on PATH matches what node-server is developed and tested against.
  // Keep this in sync with the root package.json `engines.node` range — the
  // e2b-runtime-deps test in packages/node-server/tests enforces it.
  const nodeVersion = '22.23.2';

  // vCPUs for the sandbox. e2b's default is 2, which the hosted leader has to
  // share between Chromium (browser + renderer + network/storage utilities),
  // the SLICC kernel worker (WASM shell, realms, OPFS), and node-server. Under
  // that contention the leader page's main thread stalls for tens of seconds
  // during ordinary cone work, which is long enough for the tray keepalive on
  // BOTH ends to stop hearing pongs. CPU allocation is fixed at template-build
  // time (`BasicBuildOptions`) — `Sandbox.create` has no per-sandbox override —
  // so it has to be set here.
  const cpuCount = Number(process.env['SLICC_E2B_CPU_COUNT'] ?? 4);
  if (!Number.isInteger(cpuCount) || cpuCount < 1) {
    throw new Error(
      `SLICC_E2B_CPU_COUNT must be a positive integer; got ${process.env['SLICC_E2B_CPU_COUNT']}`
    );
  }

  console.log('cwd:', process.cwd());
  console.log('repoRoot (fileContextPath):', repoRoot);
  console.log('E2B_API_KEY set:', Boolean(process.env['E2B_API_KEY']));
  console.log('Template alias:', templateName);
  console.log('vCPUs:', cpuCount);

  // fileContextPath roots all .copy() source paths at the repo root, so
  // dist/* and packages/* are reachable. Without it the SDK roots at this
  // file's directory and rejects '..' escapes.
  const template = Template({ fileContextPath: repoRoot })
    .fromImage('e2bdev/code-interpreter:latest')
    // Default user in the code-interpreter image is non-root; we need root
    // to write to /opt, /usr/local/bin, /data, /slicc.
    .setUser('root')
    .aptInstall([
      'chromium',
      'fonts-liberation',
      'libnss3',
      'libatk-bridge2.0-0',
      'libgtk-3-0',
      'libxss1',
      'libasound2',
    ])
    // Pinned Node 22 LTS (checksum-verified against the official SHASUMS256,
    // asserted on PATH so a base-image node can't silently shadow it).
    .runCmd(
      [
        'cd /tmp',
        `curl -fsSLO https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.gz`,
        `curl -fsSLO https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`,
        `grep " node-v${nodeVersion}-linux-x64.tar.gz$" SHASUMS256.txt | sha256sum -c -`,
        `tar -xzf node-v${nodeVersion}-linux-x64.tar.gz -C /usr/local --strip-components=1`,
        `rm node-v${nodeVersion}-linux-x64.tar.gz SHASUMS256.txt`,
        `[ "$(node --version)" = "v${nodeVersion}" ]`,
      ].join(' && ')
    )
    .copy('dist/node-server', '/opt/slicc/node-server')
    // No UI is bundled: node-server is a thin /cdp bridge + /api surface in
    // every mode, so the hosted leader's Chromium loads the webapp from the
    // hosted origin (sliccy.ai) rather than from a locally-served bundle.
    // Tiny package.json listing the runtime deps (kept in sync with
    // node-server's third-party value-imports by the e2b-runtime-deps test).
    // `npm install` populates /opt/slicc/node_modules; Node walks up from
    // /opt/slicc/node-server/ and resolves them.
    .copy('packages/dev-tools/e2b-template/runtime-package.json', '/opt/slicc/package.json')
    .copy('packages/dev-tools/e2b-template/start.sh', '/usr/local/bin/slicc-start', {
      mode: 0o755,
    })
    .runCmd('chmod +x /opt/slicc/node-server/index.js /usr/local/bin/slicc-start')
    // --ignore-scripts skips Electron's postinstall binary download (we never
    // actually launch Electron in --hosted mode; we just need the JS shim
    // to satisfy the import graph).
    .runCmd('cd /opt/slicc && npm install --omit=dev --ignore-scripts')
    .makeDir(['/data/profile', '/slicc'])
    .setStartCmd('slicc-start', waitForFile('/usr/local/bin/slicc-start'));

  console.log('Template definition built, starting Template.build…');
  const buildInfo = await Template.build(template, templateName, {
    cpuCount,
    memoryMB: 8192,
    onBuildLogs: defaultBuildLogger({ minLevel: 'debug' }),
  });
  console.log(`Published template ${templateName}:`, buildInfo);
}

main().catch((err: unknown) => {
  console.error('=== template build failed ===');
  if (err instanceof Error) {
    console.error('message:', err.message);
    console.error('name:', err.name);
    if (err.stack) console.error('stack:', err.stack);
    // Surface common nested fields (validation errors, axios responses, etc.)
    const e = err as Error & { cause?: unknown; response?: unknown; errors?: unknown };
    if (e.cause) console.error('cause:', e.cause);
    if (e.response) console.error('response:', e.response);
    if (e.errors) console.error('errors:', e.errors);
  } else {
    console.error('non-Error thrown:', err);
  }
  process.exit(1);
});
