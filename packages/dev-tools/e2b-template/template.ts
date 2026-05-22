/**
 * E2B v2 template definition for the SLICC hosted leader.
 *
 * Build with:
 *   npm run build                            # produces dist/node-server and dist/ui
 *   bash packages/dev-tools/e2b-template/scripts/build-template.sh
 *
 * That script cd's to the repo root and runs `npx tsx <this file>`.
 * All copy paths below are repo-root-relative.
 *
 * Requires E2B_API_KEY in env, scoped to the team you want to push to.
 */
import { Template, waitForFile } from 'e2b';

const template = Template()
  .fromImage('e2bdev/code-interpreter:latest')
  .aptInstall([
    'chromium',
    'fonts-liberation',
    'libnss3',
    'libatk-bridge2.0-0',
    'libgtk-3-0',
    'libxss1',
    'libasound2',
  ])
  .copy('dist/node-server', '/opt/slicc/node-server')
  .copy('dist/ui', '/opt/slicc/ui')
  .copy('packages/dev-tools/e2b-template/start.sh', '/usr/local/bin/slicc-start', {
    mode: 0o755,
  })
  .makeDir(['/data/profile', '/slicc'])
  .setStartCmd('slicc-start', waitForFile('/tmp/slicc-join.json'));

const buildInfo = await Template.build(template, 'slicc');
console.log('Published template slicc:', buildInfo);
