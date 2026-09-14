import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBuildLogger, Template, waitForFile } from 'e2b';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function main(): Promise<void> {
  const templateName = process.env['SLICC_E2B_TEMPLATE_NAME'] ?? 'slicc';

  const nodeVersion = '22.23.2';

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

  const template = Template({ fileContextPath: repoRoot })
    .fromImage('e2bdev/code-interpreter:latest')

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

    .copy('packages/dev-tools/e2b-template/runtime-package.json', '/opt/slicc/package.json')
    .copy('packages/dev-tools/e2b-template/start.sh', '/usr/local/bin/slicc-start', {
      mode: 0o755,
    })
    .runCmd('chmod +x /opt/slicc/node-server/index.js /usr/local/bin/slicc-start')

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

    const e = err as Error & { cause?: unknown; response?: unknown; errors?: unknown };
    if (e.cause) console.error('cause:', e.cause);
    if (e.response) console.error('response:', e.response);
    if (e.errors) console.error('errors:', e.errors);
  } else {
    console.error('non-Error thrown:', err);
  }
  process.exit(1);
});
