import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpusDocument } from '../../webapp/src/scoops/tray-sync-protocol-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));

const swiftMirror = resolve(
  here,
  '../../swift-trayfollower/Sources/SliccTrayFollower/Models/SyncProtocol.swift'
);
const out = resolve(
  here,
  '../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/tray-sync-corpus.json'
);

const document = buildCorpusDocument();

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
