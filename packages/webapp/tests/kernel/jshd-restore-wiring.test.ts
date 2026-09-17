/**
 * Pins the fire-and-forget jshd restore hook in createKernelHost so a
 * refactor cannot drop it from the boot sequence or hoist the supervisor
 * into the eager worker graph.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, '..', '..', 'src', 'kernel', 'host.ts');
const source = readFileSync(hostPath, 'utf8');

describe('jshd boot restore wiring', () => {
  it('schedules restore after mount recovery and before cone bootstrap', () => {
    const mount = source.indexOf('scheduleMountRecovery(sharedFs');
    const restore = source.indexOf('scheduleJshdRestore(sharedFs');
    const cone = source.indexOf('await bootstrapCone(');
    expect(mount).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(mount);
    expect(cone).toBeGreaterThan(restore);
  });

  it('lazy-imports the restore body so the supervisor stays off first-load', () => {
    expect(source).toMatch(
      /await import\(\s*['"]\.\.\/shell\/supplemental-commands\/jshd\/restore\.js['"]\s*\)/
    );
    expect(source).not.toMatch(/from ['"]\.\.\/shell\/supplemental-commands\/jshd\//);
  });
});
