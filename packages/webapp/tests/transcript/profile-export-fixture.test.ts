import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PROFILE_MANIFEST_PATH,
  type SliccProfileManifestV1,
  type TranscriptDocumentV1,
  validateSliccProfileManifestV1,
  validateTranscriptDocumentV1,
} from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';
import { describe, expect, it } from 'vitest';
import { planProfileExport } from '../../src/transcript/profile-export.js';
import { readStoredZip, seedProfile } from './profile-export-seed.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/slicc6-profile-v1.zip', import.meta.url));

type Entries = { name: string; data: Uint8Array }[];
const json = <T>(data: Uint8Array): T => JSON.parse(new TextDecoder().decode(data)) as T;

function fixtureEntries(): Entries {
  return readStoredZip(new Uint8Array(readFileSync(FIXTURE)));
}

async function exporterEntries(): Promise<Entries> {
  const { deps } = await seedProfile();
  const plan = await planProfileExport(deps);
  const stream = plan.archives[0]!.open();
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream.chunks) chunks.push(chunk);
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return readStoredZip(bytes);
}

function layout(entries: Entries): string[] {
  const shapes = new Set<string>();
  for (const { name } of entries) {
    const parts = name.split('/');
    if (parts.length === 1) shapes.add(name);
    else if (parts[0] === 'files') shapes.add(`files/${parts[1]}/*`);
    else if (parts[0] === 'memory') shapes.add(parts[1] === 'global.md' ? name : 'memory/*.md');
    else shapes.add(`${parts[0]}/*`);
  }
  return [...shapes].sort();
}

const keys = (value: object): string[] => Object.keys(value).sort();

describe('slicc6-profile-v1.zip (shared fixture)', () => {
  it('passes the schema check: manifest first, valid, every entry listed and hashed', () => {
    const entries = fixtureEntries();
    expect(entries[0]!.name).toBe(PROFILE_MANIFEST_PATH);
    const manifest = json<SliccProfileManifestV1>(entries[0]!.data);
    expect(validateSliccProfileManifestV1(manifest)).toEqual({ ok: true });
    const listed = new Map(manifest.files.map((f) => [f.path, f]));
    expect(listed.size).toBe(entries.length - 1);
    for (const entry of entries.slice(1)) {
      expect(listed.get(entry.name)?.sha256, entry.name).toBe(sha256(entry.data));
      expect(listed.get(entry.name)?.size, entry.name).toBe(entry.data.byteLength);
      if (entry.name.startsWith('attachments/')) {
        expect(entry.name).toBe(`attachments/${sha256(entry.data)}`);
      }
      if (/^(transcripts|frozen)\//.test(entry.name)) {
        const doc = json<TranscriptDocumentV1>(entry.data);
        expect(validateTranscriptDocumentV1(doc), entry.name).toEqual({ ok: true });
      }
    }
  });

  it('matches the structure of what the exporter writes for a seeded profile', async () => {
    const fixture = fixtureEntries();
    const exported = await exporterEntries();
    expect(layout(exported)).toEqual(layout(fixture));

    const fm = json<SliccProfileManifestV1>(fixture[0]!.data);
    const em = json<SliccProfileManifestV1>(exported[0]!.data);
    expect(keys(em)).toEqual(keys(fm));
    expect(keys(em.producer)).toEqual(keys(fm.producer));
    expect(keys(em.cones[0]!)).toEqual(keys(fm.cones[0]!));
    expect(keys(em.cones[0]!.scoops[0]!)).toEqual(keys(fm.cones[0]!.scoops[0]!));
    expect(keys(em.frozen[0]!)).toEqual(keys(fm.frozen[0]!));
    expect(keys(em.totals)).toEqual(keys(fm.totals));
    expect(keys(em.flagged[0]!)).toEqual(keys(fm.flagged[0]!));
    expect(keys(em.skipped[0]!)).toEqual(keys(fm.skipped[0]!));

    const licks = (entries: Entries) =>
      json<{ [k: string]: { [field: string]: unknown }[] }>(
        entries.find((e) => e.name === 'licks.json')!.data
      );
    const fl = licks(fixture);
    const el = licks(exported);
    expect(keys(el)).toEqual(keys(fl));
    expect(el['crontasks']![0]).toHaveProperty('targetFolder');
    expect(fl['crontasks']![0]).toHaveProperty('targetFolder');
    expect(el['webhooks']![0]).toHaveProperty('targetFolder');
    expect(fl['webhooks']![0]).toHaveProperty('targetFolder');
  });
});
