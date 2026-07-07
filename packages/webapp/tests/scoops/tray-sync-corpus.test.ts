import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCorpusDocument,
  FOLLOWER_TO_LEADER_CORPUS,
  LEADER_TO_FOLLOWER_CORPUS,
} from '../../src/scoops/tray-sync-protocol-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusJsonPath = resolve(
  here,
  '../../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/tray-sync-corpus.json'
);

// The corpus module's mapped types enforce completeness at compile time; this
// suite enforces that the checked-in JSON (shared with the Swift test target)
// matches the module, so the two suites always decode the same bytes.
describe('tray sync golden-fixture corpus', () => {
  it('checked-in JSON matches the TS source of truth', () => {
    let onDisk: unknown;
    try {
      onDisk = JSON.parse(readFileSync(corpusJsonPath, 'utf8'));
    } catch {
      onDisk = '<missing or unparseable>';
    }
    expect(
      onDisk,
      'tray-sync-corpus.json drifted from tray-sync-protocol-corpus.ts — regenerate with: npx tsx packages/dev-tools/tools/generate-tray-sync-corpus.ts'
    ).toEqual(buildCorpusDocument());
  });

  it('every fixture declares the type it is keyed under', () => {
    for (const [key, { message }] of Object.entries(LEADER_TO_FOLLOWER_CORPUS)) {
      expect(message.type).toBe(key);
    }
    for (const [key, { message }] of Object.entries(FOLLOWER_TO_LEADER_CORPUS)) {
      expect(message.type).toBe(key);
    }
  });

  it('every fixture survives a JSON round-trip (what the data channel does)', () => {
    const all = [
      ...Object.values(LEADER_TO_FOLLOWER_CORPUS),
      ...Object.values(FOLLOWER_TO_LEADER_CORPUS),
    ];
    for (const { message } of all) {
      let roundTripped: unknown;
      try {
        roundTripped = JSON.parse(JSON.stringify(message)) as unknown;
      } catch {
        roundTripped = undefined; // the expect below fails loudly
      }
      expect(roundTripped).toEqual(message);
    }
  });
});
