/**
 * CI check: the tray message matrix in docs/architecture.md must stay
 * in sync with the protocol unions (#1393, P2-2 of #1294).
 *
 * The corpus mapped types already enforce that every union variant has
 * a fixture entry (adding a variant fails typecheck until the corpus
 * gains a key). This test closes the third leg: the human-authored
 * doc table must list every variant too.
 *
 * The test checks set-equality in both directions:
 *  1. Every corpus variant has a row in the matrix.
 *  2. Every matrix row names a real corpus variant.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FOLLOWER_TO_LEADER_CORPUS,
  LEADER_TO_FOLLOWER_CORPUS,
} from '../../src/scoops/tray-sync-protocol-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const architectureMdPath = resolve(here, '../../../../docs/architecture.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the markdown table between the sentinel comments. */
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

/**
 * Parse message names from the matrix table rows.
 *
 * Each row's "Message" column may list multiple backtick-delimited
 * names separated by commas (e.g. `` `ping`, `pong` ``).
 * Returns two sets: leader→follower variants and follower→leader.
 */
function parseMatrixVariants(table: string): {
  leaderToFollower: Set<string>;
  followerToLeader: Set<string>;
} {
  const leaderToFollower = new Set<string>();
  const followerToLeader = new Set<string>();

  for (const line of table.split('\n')) {
    // Skip non-table lines and the separator row
    if (!line.startsWith('|') || line.includes('---')) continue;
    // Skip the header row
    const cols = line.split('|').map((c) => c.trim());
    // cols[0] is empty (before first |), cols[1] = Direction, etc.
    const direction = cols[1];
    const messageCol = cols[2];
    if (!direction || !messageCol) continue;
    if (direction === 'Direction') continue; // header

    // Extract all backtick-wrapped names
    const names = [...messageCol.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

    const target = direction.includes('Leader→Follower')
      ? leaderToFollower
      : direction.includes('Follower→Leader')
        ? followerToLeader
        : null;
    if (target) {
      for (const name of names) target.add(name);
    }
  }

  return { leaderToFollower, followerToLeader };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
});
