import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_CORPUS,
  buildCorpusDocument,
  FOLLOWER_TO_LEADER_CORPUS,
  LEADER_TO_FOLLOWER_CORPUS,
  NESTED_PAYLOAD_CORPUS,
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

  it('every agent-event fixture declares the type it is keyed under', () => {
    for (const [key, { event }] of Object.entries(AGENT_EVENT_CORPUS)) {
      expect(event.type).toBe(key);
    }
  });

  // The mapped type forces a per-field CLASSIFICATION; this forces the sample
  // to actually carry every field classified as crossing the wire. Without it,
  // classifying a new optional field as `mirrored` and never populating it
  // would leave the Swift round-trip with nothing to catch.
  it('every nested payload sample populates all non-local fields', () => {
    for (const [name, entry] of Object.entries(NESTED_PAYLOAD_CORPUS)) {
      const sample: Record<string, unknown> = { ...entry.sample };
      for (const [field, expectation] of Object.entries(entry.fields)) {
        if (expectation === 'local') {
          expect(
            Object.hasOwn(sample, field),
            `${name}.${field} is classified 'local' but the fixture sends it`
          ).toBe(false);
          continue;
        }
        expect(
          Object.hasOwn(sample, field),
          `${name}.${field} is classified '${expectation}' but the fixture omits it — a mirror dropping it would go unnoticed`
        ).toBe(true);
        expect(sample[field], `${name}.${field} is populated with undefined`).not.toBeUndefined();
      }
    }
  });

  it('nested payload samples carry no field outside their expectation map', () => {
    for (const [name, entry] of Object.entries(NESTED_PAYLOAD_CORPUS)) {
      const classified = new Set(Object.keys(entry.fields));
      for (const field of Object.keys(entry.sample)) {
        expect(classified.has(field), `${name}.${field} is in the sample but unclassified`).toBe(
          true
        );
      }
    }
  });

  // `absent` means no Swift type exists, so there is nothing to mirror; a
  // field marked `mirrored` under it would assert a round-trip that cannot run.
  it('payloads with no iOS mirror classify every field as dropped', () => {
    for (const [name, entry] of Object.entries(NESTED_PAYLOAD_CORPUS)) {
      if (entry.ios !== 'absent') continue;
      for (const [field, expectation] of Object.entries(entry.fields)) {
        expect(
          expectation,
          `${name}.${field} cannot be '${expectation}' — ${name} has no iOS mirror`
        ).toBe('dropped');
      }
    }
  });
});
