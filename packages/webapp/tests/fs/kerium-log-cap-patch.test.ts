import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the kerium bounded-log-backlog patch.
//
// kerium's `log()` retains EVERY entry in a module-global List (a plain Set
// underneath) — including entries below the output threshold that are never
// printed — with no cap or rotation. In a long-lived kernel worker under log
// pressure (ZenFS's per-inode "nlink of 0" warning at its worst) the Set
// eventually hits V8's 2^24-element cap, after which `entries.add` throws
// `RangeError: Set maximum size exceeded` into every logging caller: every
// ZenFS operation failed and the VFS root went offline (2026-08-18 incident;
// the UI read "file system too full" while storage sat at 14% of quota).
//
// patches/kerium+*.patch bounds the backlog to a 10,000-entry ring. These
// tests fail if the patch is missing or stops applying.
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
    // DEBUG sits below the default output threshold (ALERT), so the flood
    // exercises pure retention without spamming the test output.
    for (let i = 0; i < 12_345; i++) log(Level.DEBUG, `flood ${i}`);
    expect(entries.size).toBeLessThanOrEqual(10_000);
    const messages = entries.toArray().map((entry: { message: string }) => entry.message);
    expect(messages.at(-1)).toBe('flood 12344'); // newest retained
    expect(messages).not.toContain('flood 0'); // oldest evicted
  });
});
