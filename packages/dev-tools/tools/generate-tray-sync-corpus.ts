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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpusDocument } from '../../webapp/src/scoops/tray-sync-protocol-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
// The Swift mirror moved out of ios-app when SliccTrayFollower became its own
// gated package (a34ccaa74); this path went stale and the generator has been
// throwing ENOENT ever since, which is only visible when someone regenerates.
const swiftMirror = resolve(
  here,
  '../../swift-trayfollower/Sources/SliccTrayFollower/Models/SyncProtocol.swift'
);
const out = resolve(
  here,
  '../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/tray-sync-corpus.json'
);

const document = buildCorpusDocument();

// `@slicc/shared-ts` resolves types from `src/` but RUNTIME from `dist/`, so a
// stale or missing `dist` hands this script an out-of-date
// `TRAY_SYNC_PROTOCOL_VERSION` and it writes a wrong version with exit 0. The
// Swift suite asserts the two are equal, so that lands as a confusing iOS-only
// CI failure far from the cause. Cross-check here and fail loudly instead.
const swiftSource = readFileSync(swiftMirror, 'utf8');
const swiftVersion = Number(
  /^\s*(?:(?:public|internal|package|fileprivate|private)\s+)?let\s+traySyncProtocolVersion\s*=\s*(\d+)/m.exec(
    swiftSource
  )?.[1] ?? Number.NaN
);
if (!Number.isInteger(swiftVersion)) {
  throw new Error(
    `Could not read 'let traySyncProtocolVersion' with an optional access modifier from ${swiftMirror}`
  );
}
if (document.traySyncProtocolVersion !== swiftVersion) {
  throw new Error(
    `Refusing to write a corpus with traySyncProtocolVersion=${document.traySyncProtocolVersion} ` +
      `while the Swift mirror declares ${swiftVersion}.\n` +
      'If this is an intentional protocol bump, update SyncProtocol.swift in the same change. ' +
      'Otherwise your @slicc/shared-ts dist/ is stale — run: npm run build -w @slicc/shared-ts'
  );
}

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${out} (protocol version ${swiftVersion})`);
