/**
 * Pins the awaited jshd restore hook in createKernelHost so a refactor
 * cannot drop it from the boot sequence, run it before mounts, or hoist
 * the supervisor into the eager worker graph.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, '..', '..', 'src', 'kernel', 'host.ts');
const source = readFileSync(hostPath, 'utf8');

describe('jshd boot restore wiring', () => {
  it('awaits mount recovery, then jshd restore, then cone bootstrap', () => {
    const step = source.indexOf('await restoreMountsThenJshd(sharedFs');
    const mount = source.indexOf('await recoverPersistedMounts(sharedFs');
    const restore = source.indexOf('await restoreJshdUnits(sharedFs');
    const cone = source.indexOf('await bootstrapCone(');
    expect(step).toBeGreaterThan(0);
    expect(mount).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(mount);
    expect(cone).toBeGreaterThan(step);
    expect(cone).toBeGreaterThan(restore);
  });

  it('lazy-imports the restore body so the supervisor stays off first-load', () => {
    expect(source).toMatch(
      /await import\(\s*['"]\.\.\/shell\/supplemental-commands\/jshd\/restore\.js['"]\s*\)/
    );
    expect(source).not.toMatch(/from ['"]\.\.\/shell\/supplemental-commands\/jshd\//);
  });
});
