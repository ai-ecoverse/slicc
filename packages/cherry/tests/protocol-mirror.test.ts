import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

// The SDK copy and the canonical webapp copy must stay structurally identical
// from the contract body onward. The ONLY intended difference is the header
// doc block (the SDK copy explains why it carries no webapp import), so we
// compare everything from the first `export const CHERRY_PROTOCOL_VERSION`.
const MARKER = 'export const CHERRY_PROTOCOL_VERSION';

function contractBody(absPath: string): string {
  const text = readFileSync(absPath, 'utf8');
  const idx = text.indexOf(MARKER);
  if (idx === -1) throw new Error(`Marker "${MARKER}" not found in ${absPath}`);
  // Normalize trailing whitespace so a stray newline doesn't trip the guard.
  return text.slice(idx).replace(/\s+$/, '');
}

describe('cherry protocol mirror invariant', () => {
  const sdkCopy = resolve(here, '../src/protocol.ts');
  const canonicalCopy = resolve(here, '../../webapp/src/cdp/cherry-host-protocol.ts');

  it('keeps the SDK protocol.ts body byte-identical to the canonical webapp copy', () => {
    expect(contractBody(sdkCopy)).toBe(contractBody(canonicalCopy));
  });
});
