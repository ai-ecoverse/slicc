import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';
import { execInTerminal } from './two-instance-helpers.js';

const CLONE_URL = 'https://github.com/ai-ecoverse/skills.git';

test.describe('live git clone (real network)', () => {
  test('clones ai-ecoverse/skills and surfaces the real result', async ({ page }, testInfo) => {
    test.setTimeout(5 * 60_000);

    await seedSkipSwReload(page);

    await gotoLeader(page);
    await waitForSW(page);

    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    const targetDir = '/workspace/skills-live-clone';
    const cloneCmd = `git clone --branch slicc-e2e-fixture --single-branch ${CLONE_URL} ${targetDir}`;
    await execInTerminal(page, `rm -rf ${targetDir}`);
    const clone = await execInTerminal(page, cloneCmd);

    const report =
      `command: ${cloneCmd}\n` +
      `exitCode: ${clone.exitCode}\n` +
      `--- stdout ---\n${clone.stdout}\n` +
      `--- stderr ---\n${clone.stderr}`;
    await testInfo.attach('git-clone-output', { body: report, contentType: 'text/plain' });

    console.log('\n=== live git clone result ===\n' + report + '\n=============================\n');

    expect(clone.exitCode, `git clone did not exit 0 — full output:\n${report}`).toBe(0);

    const checkedOut = clone.stdout.match(/Checked out (\d+) files\./);
    expect(checkedOut, `expected "Checked out N files." — full output:\n${report}`).not.toBeNull();
    expect(Number(checkedOut?.[1] ?? '0'), 'checked-out file count').toBeGreaterThan(0);

    const deepFile = `${targetDir}/skills/suno/references/endpoints.md`;
    const deep = await execInTerminal(page, `[ -f ${deepFile} ] && echo FILE_OK`);
    expect(deep.exitCode, `[ -f ${deepFile} ] failed: ${JSON.stringify(deep)}`).toBe(0);
    expect(deep.stdout).toContain('FILE_OK');

    const symlink = `${targetDir}/tiles/advanced/skills/slack`;
    const link = await execInTerminal(page, `[ -L ${symlink} ] && readlink ${symlink}`);
    expect(link.exitCode, `[ -L ${symlink} ] failed: ${JSON.stringify(link)}`).toBe(0);
    expect(link.stdout.trim(), `readlink ${symlink} target`).not.toBe('');
  });
});
