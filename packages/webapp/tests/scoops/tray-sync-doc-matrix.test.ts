import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRAY_SYNC_PROTOCOL_VERSION } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import {
  FOLLOWER_TO_LEADER_CORPUS,
  LEADER_TO_FOLLOWER_CORPUS,
} from '../../src/scoops/tray-sync-protocol-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const architectureMdPath = resolve(here, '../../../../docs/architecture.md');
const webappDetailsMdPath = resolve(here, '../../../../docs/webapp-details.md');

function extractMatrix(md: string): string {
  const start = '<!-- tray-sync-matrix:start -->';
  const end = '<!-- tray-sync-matrix:end -->';
  const startIdx = md.indexOf(start);
  const endIdx = md.indexOf(end);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `docs/architecture.md is missing the sentinel comments ` +
        `(${start} / ${end}). ` +
        `Add them around the tray message matrix table.`
    );
  }
  return md.slice(startIdx + start.length, endIdx);
}

function parseMatrixVariants(table: string): {
  leaderToFollower: Set<string>;
  followerToLeader: Set<string>;

  l2fFollowers: Map<string, string>;
  f2lFollowers: Map<string, string>;
} {
  const leaderToFollower = new Set<string>();
  const followerToLeader = new Set<string>();
  const l2fFollowers = new Map<string, string>();
  const f2lFollowers = new Map<string, string>();

  for (const line of table.split('\n')) {
    if (!line.startsWith('|') || line.includes('---')) continue;

    const cols = line.split('|').map((c) => c.trim());

    const direction = cols[1];
    const messageCol = cols[2];
    if (!direction || !messageCol) continue;
    if (direction === 'Direction') continue;

    const names = [...messageCol.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

    const isBidi = direction.includes('Bidirectional');
    const isL2F = isBidi || direction.includes('Leader→Follower');
    const isF2L = isBidi || direction.includes('Follower→Leader');
    for (const name of names) {
      if (isL2F) leaderToFollower.add(name);
      if (isF2L) followerToLeader.add(name);
      if (cols[3] && isL2F) l2fFollowers.set(name, cols[3]);
      if (cols[3] && isF2L) f2lFollowers.set(name, cols[3]);
    }
  }

  return { leaderToFollower, followerToLeader, l2fFollowers, f2lFollowers };
}

describe('tray sync doc matrix ↔ protocol unions', () => {
  const md = readFileSync(architectureMdPath, 'utf8');
  const table = extractMatrix(md);
  const docVariants = parseMatrixVariants(table);

  const corpusLeader = new Set(Object.keys(LEADER_TO_FOLLOWER_CORPUS));
  const corpusFollower = new Set(Object.keys(FOLLOWER_TO_LEADER_CORPUS));

  it('every Leader→Follower union variant has a doc row', () => {
    const missing = [...corpusLeader].filter((v) => !docVariants.leaderToFollower.has(v));
    expect(
      missing,
      `Leader→Follower variants missing from docs/architecture.md matrix: ` +
        `${missing.map((v) => `\`${v}\``).join(', ')}. ` +
        `Add a row for each inside the <!-- tray-sync-matrix --> markers.`
    ).toEqual([]);
  });

  it('every doc row names a real Leader→Follower variant', () => {
    const extra = [...docVariants.leaderToFollower].filter((v) => !corpusLeader.has(v));
    expect(
      extra,
      `Leader→Follower doc rows that don't match any union variant: ` +
        `${extra.map((v) => `\`${v}\``).join(', ')}. ` +
        `Remove or rename them in docs/architecture.md.`
    ).toEqual([]);
  });

  it('every Follower→Leader union variant has a doc row', () => {
    const missing = [...corpusFollower].filter((v) => !docVariants.followerToLeader.has(v));
    expect(
      missing,
      `Follower→Leader variants missing from docs/architecture.md matrix: ` +
        `${missing.map((v) => `\`${v}\``).join(', ')}. ` +
        `Add a row for each inside the <!-- tray-sync-matrix --> markers.`
    ).toEqual([]);
  });

  it('every doc row names a real Follower→Leader variant', () => {
    const extra = [...docVariants.followerToLeader].filter((v) => !corpusFollower.has(v));
    expect(
      extra,
      `Follower→Leader doc rows that don't match any union variant: ` +
        `${extra.map((v) => `\`${v}\``).join(', ')}. ` +
        `Remove or rename them in docs/architecture.md.`
    ).toEqual([]);
  });

  it('the Followers column agrees with the corpus about iOS support', () => {
    const mismatches: string[] = [];
    const check = (
      direction: string,
      column: Map<string, string>,
      variant: string,
      iosSupported: boolean
    ) => {
      const cell = column.get(variant);
      if (cell === undefined) return;
      const claimsIos = /\biOS\b/i.test(cell);
      if (claimsIos !== iosSupported) {
        mismatches.push(
          `\`${variant}\` (${direction}): docs say "${cell}" but the corpus says iOS ` +
            `${iosSupported ? 'handles' : 'does not handle'} it`
        );
      }
    };

    for (const [variant, entry] of Object.entries(LEADER_TO_FOLLOWER_CORPUS)) {
      check('Leader→Follower', docVariants.l2fFollowers, variant, entry.ios === 'decoded');
    }

    for (const [variant, entry] of Object.entries(FOLLOWER_TO_LEADER_CORPUS)) {
      check('Follower→Leader', docVariants.f2lFollowers, variant, entry.ios === 'decoded');
    }

    expect(
      mismatches,
      `docs/architecture.md "Followers" column is out of sync with the corpus:\n` +
        `${mismatches.join('\n')}\n` +
        `Update the column, or the corpus entry if support really changed.`
    ).toEqual([]);
  });

  it('documents protocol version and user_message_ack surface behavior (#3482)', () => {
    expect(md).toContain(`\`TRAY_SYNC_PROTOCOL_VERSION\` is **${TRAY_SYNC_PROTOCOL_VERSION}**`);
    expect(md).toContain('**v10 is the `user_message_ack` boundary**');
    const ackRow = table
      .split('\n')
      .find((line) => line.includes('`user_message_ack`') && line.includes('Leader→Follower'));
    expect(ackRow, 'matrix must list user_message_ack').toBeDefined();
    expect(ackRow).not.toMatch(/unknown for now/i);

    expect(ackRow).toContain('once its kernel took the prompt');
    expect(ackRow).toContain('panel-RPC');
    expect(ackRow).toContain('bounded ~5s');
    expect(ackRow).toContain("iOS flags the sender's bubble");
    expect(ackRow).toContain('tray sidecar');
    expect(ackRow).toContain('print `rejected`');
    expect(ackRow).toContain('messageId');

    const webappDetails = readFileSync(webappDetailsMdPath, 'utf8');
    expect(webappDetails).toContain('#3482` surface checklist');
    expect(webappDetails).toContain('Cherry / extension side panel');
    expect(webappDetails).toContain('Electron overlay');
    expect(webappDetails).toContain('Tray sidecar');
    expect(webappDetails).toContain('slicc-cli` `prompt`');
    expect(webappDetails).toContain('iOS bubble / ledger');
  });
});
