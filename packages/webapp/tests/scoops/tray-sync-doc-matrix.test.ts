import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FOLLOWER_TO_LEADER_CORPUS,
  LEADER_TO_FOLLOWER_CORPUS,
} from '../../src/scoops/tray-sync-protocol-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const architectureMdPath = resolve(here, '../../../../docs/architecture.md');
const repoRoot = resolve(here, '../../../..');
const onNoComment = existsSync(resolve(repoRoot, '.no-comment'));

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

describe.skipIf(onNoComment)('tray sync doc matrix ↔ protocol unions', () => {
  const loadDocVariants = () => {
    const md = readFileSync(architectureMdPath, 'utf8');
    return parseMatrixVariants(extractMatrix(md));
  };

  const corpusLeader = new Set(Object.keys(LEADER_TO_FOLLOWER_CORPUS));
  const corpusFollower = new Set(Object.keys(FOLLOWER_TO_LEADER_CORPUS));

  it('every Leader→Follower union variant has a doc row', () => {
    const docVariants = loadDocVariants();
    const missing = [...corpusLeader].filter((v) => !docVariants.leaderToFollower.has(v));
    expect(
      missing,
      `Leader→Follower variants missing from docs/architecture.md matrix: ` +
        `${missing.map((v) => `\`${v}\``).join(', ')}. ` +
        `Add a row for each inside the <!-- tray-sync-matrix --> markers.`
    ).toEqual([]);
  });

  it('every doc row names a real Leader→Follower variant', () => {
    const docVariants = loadDocVariants();
    const extra = [...docVariants.leaderToFollower].filter((v) => !corpusLeader.has(v));
    expect(
      extra,
      `Leader→Follower doc rows that don't match any union variant: ` +
        `${extra.map((v) => `\`${v}\``).join(', ')}. ` +
        `Remove or rename them in docs/architecture.md.`
    ).toEqual([]);
  });

  it('every Follower→Leader union variant has a doc row', () => {
    const docVariants = loadDocVariants();
    const missing = [...corpusFollower].filter((v) => !docVariants.followerToLeader.has(v));
    expect(
      missing,
      `Follower→Leader variants missing from docs/architecture.md matrix: ` +
        `${missing.map((v) => `\`${v}\``).join(', ')}. ` +
        `Add a row for each inside the <!-- tray-sync-matrix --> markers.`
    ).toEqual([]);
  });

  it('every doc row names a real Follower→Leader variant', () => {
    const docVariants = loadDocVariants();
    const extra = [...docVariants.followerToLeader].filter((v) => !corpusFollower.has(v));
    expect(
      extra,
      `Follower→Leader doc rows that don't match any union variant: ` +
        `${extra.map((v) => `\`${v}\``).join(', ')}. ` +
        `Remove or rename them in docs/architecture.md.`
    ).toEqual([]);
  });

  it('the Followers column agrees with the corpus about iOS support', () => {
    const docVariants = loadDocVariants();
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
});
