/**
 * Regenerate the tray-sync golden-fixture corpus JSON from its TS source of
 * truth (`packages/webapp/src/scoops/tray-sync-protocol-corpus.ts`).
 *
 * Usage: npx tsx packages/dev-tools/tools/generate-tray-sync-corpus.ts
 *
 * The vitest guard (`packages/webapp/tests/scoops/tray-sync-corpus.test.ts`)
 * fails whenever the checked-in JSON drifts from the TS module; running this
 * script is the fix it suggests.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpusDocument } from '../../webapp/src/scoops/tray-sync-protocol-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(
  here,
  '../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/tray-sync-corpus.json'
);

writeFileSync(out, `${JSON.stringify(buildCorpusDocument(), null, 2)}\n`);
console.log(`Wrote ${out}`);
