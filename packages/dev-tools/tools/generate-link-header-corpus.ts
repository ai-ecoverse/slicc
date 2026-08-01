/**
 * Regenerate the `Link` header / handoff golden corpus from its TS source of
 * truth (`packages/webapp/src/net/link-header-corpus.ts`).
 *
 * Usage: npx tsx packages/dev-tools/tools/generate-link-header-corpus.ts
 *
 * The vitest guard (`packages/webapp/tests/net/link-header-corpus.test.ts`)
 * both validates every case against the real TS parser and fails when the
 * checked-in JSON drifts from the module; running this script is the fix.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinkHeaderCorpusDocument } from '../../webapp/src/net/link-header-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(
  here,
  '../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/link-header-corpus.json'
);

const document = buildLinkHeaderCorpusDocument();
if (document.cases.length !== document.caseCount) {
  throw new Error('corpus caseCount is out of sync with its own case list');
}

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`Wrote ${out} (${document.caseCount} cases)`);
