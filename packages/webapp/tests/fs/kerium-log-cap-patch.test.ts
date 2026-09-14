import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const logJsPath = resolve(repoRoot, 'node_modules/kerium/dist/log.js');

describe('kerium bounded log backlog patch', () => {
  it('the ring-eviction patch is present in the installed dist', () => {
    const src = readFileSync(logJsPath, 'utf8');
    expect(
      src.includes('entries.size >= 10000'),
      'Installed kerium retains an unbounded log backlog; patches/kerium+*.patch ' +
        'is missing or failed to apply. A long-lived kernel worker will hit ' +
        "V8's 2^24 Set cap and every ZenFS op will throw " +
        '"Set maximum size exceeded". See patches/README.md.'
    ).toBe(true);
  });

  it('behaviorally: the backlog stays bounded and keeps the newest entries', async () => {
    const { entries, log, Level } = await import(/* @vite-ignore */ logJsPath);

    for (let i = 0; i < 12_345; i++) log(Level.DEBUG, `flood ${i}`);
    expect(entries.size).toBeLessThanOrEqual(10_000);
    const messages = entries.toArray().map((entry: { message: string }) => entry.message);
    expect(messages.at(-1)).toBe('flood 12344');
    expect(messages).not.toContain('flood 0');
  });
});
