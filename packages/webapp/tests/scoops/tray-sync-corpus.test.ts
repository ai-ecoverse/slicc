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

  it('carries each cone’s own model on ScoopSummary, mirrored by iOS (#2310)', () => {
    const summary = NESTED_PAYLOAD_CORPUS.ScoopSummary;
    expect(summary.fields.model).toBe('mirrored');
    expect(summary.sample.model).toEqual({ provider: 'example', id: 'reasoner' });
    // The pick a follower sends names the cone it applies to; without it the
    // leader would fall back to the unit that follower happens to be viewing.
    expect(FOLLOWER_TO_LEADER_CORPUS['model.select'].message).toMatchObject({
      modelId: 'example:reasoner',
      scoopJid: 'cone',
    });
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

  // A Swift test cannot assert that a Swift type does NOT exist, so `absent`
  // is held honest from this side: the fields that carry the payload must stay
  // `dropped`. Promoting `ChatMessage.attachments` to `mirrored` without
  // promoting `MessageAttachment` fails here, which is what makes `absent` a
  // real ratchet rather than a comment.
  it('absent payloads name their carriers, and every carrier is still dropped', () => {
    const classifications = new Map(
      Object.entries(NESTED_PAYLOAD_CORPUS).flatMap(([name, entry]) =>
        Object.entries(entry.fields).map(([field, expectation]) => [
          `${name}.${field}`,
          expectation as string,
        ])
      )
    );
    for (const [name, entry] of Object.entries(NESTED_PAYLOAD_CORPUS)) {
      if (entry.ios !== 'absent') continue;
      const carriers = 'carriedBy' in entry ? (entry.carriedBy as string[] | undefined) : undefined;
      expect(
        carriers?.length ?? 0,
        `${name} is 'absent' but names no carrier field`
      ).toBeGreaterThan(0);
      for (const carrier of carriers ?? []) {
        expect(classifications.has(carrier), `${name} names unknown carrier '${carrier}'`).toBe(
          true
        );
        expect(
          classifications.get(carrier),
          `'${carrier}' is no longer dropped, so ${name} now reaches iOS — promote it from 'absent' to 'mirrored'`
        ).toBe('dropped');
      }
    }
  });

  it('every agent-event fixture populates exactly its classified fields', () => {
    for (const [type, entry] of Object.entries(AGENT_EVENT_CORPUS)) {
      const event: Record<string, unknown> = { ...entry.event };
      for (const field of Object.keys(entry.fields)) {
        expect(
          Object.hasOwn(event, field),
          `agent event ${type}.${field} is classified but the fixture omits it`
        ).toBe(true);
      }
      for (const field of Object.keys(event)) {
        expect(
          Object.hasOwn(entry.fields, field),
          `agent event ${type}.${field} is in the fixture but unclassified`
        ).toBe(true);
      }
    }
  });

  // `.unknown` re-encodes the type tag and nothing else, so a variant iOS does
  // not decode cannot preserve any payload field.
  it('agent events iOS does not decode keep only the type tag', () => {
    for (const [type, entry] of Object.entries(AGENT_EVENT_CORPUS)) {
      if (entry.ios !== 'unknown') continue;
      for (const [field, expectation] of Object.entries(entry.fields)) {
        expect(
          expectation,
          `${type}.${field} cannot be '${expectation}' — iOS decodes ${type} to .unknown`
        ).toBe(field === 'type' ? 'mirrored' : 'dropped');
      }
    }
  });
});
