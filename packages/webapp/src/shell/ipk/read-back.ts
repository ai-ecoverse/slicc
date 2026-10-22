/**
 * Read-back checks for installer writes (#4097, #4101): `fs.writeFile`
 * resolving is not proof the bytes landed, so installers re-read what they
 * wrote and compare it with the source bytes.
 */

import type { VirtualFS } from '../../fs/index.js';

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Why the file at `path` does not hold `expected`, or null when it does. */
export async function readBackFault(
  fs: VirtualFS,
  path: string,
  expected: Uint8Array
): Promise<string | null> {
  let actual: Uint8Array;
  try {
    actual = (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (sameBytes(actual, expected)) return null;
  if (actual.byteLength > 0 && actual.every((b) => b === 0)) {
    return `${actual.byteLength} NUL bytes`;
  }
  if (path.endsWith('.json')) {
    try {
      JSON.parse(new TextDecoder().decode(actual));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return `${actual.byteLength} bytes that differ from the expected ${expected.byteLength}`;
}
