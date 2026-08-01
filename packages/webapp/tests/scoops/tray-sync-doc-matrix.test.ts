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
  /**
   * Message name → that row's "Followers" cell, kept per direction. Several
   * variants (`cdp.request`, `tab.open`, …) appear in both directions with
   * different support, so a single name-keyed map would silently take
   * whichever row came last.
   */
  l2fFollowers: Map<string, string>;
  f2lFollowers: Map<string, string>;
} {
  const leaderToFollower = new Set<string>();
  const followerToLeader = new Set<string>();
  const l2fFollowers = new Map<string, string>();
  const f2lFollowers = new Map<string, string>();

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

  /**
   * The fourth leg. Row *existence* was already enforced above, but the
   * "Followers" column was not — so a variant could gain iOS support (or lose
   * it) and the table would keep asserting the old answer indefinitely. The
   * corpus is the ground truth: its `ios` field is what the Swift decoder is
   * actually tested against.
   */
  it('the Followers column agrees with the corpus about iOS support', () => {
    const mismatches: string[] = [];
    const check = (
      direction: string,
      column: Map<string, string>,
      variant: string,
      iosSupported: boolean
    ) => {
      const cell = column.get(variant);
      if (cell === undefined) return; // absence is the other tests' job
      const claimsIos = /\biOS\b/i.test(cell);
      if (claimsIos !== iosSupported) {
        mismatches.push(
          `\`${variant}\` (${direction}): docs say "${cell}" but the corpus says iOS ` +
            `${iosSupported ? 'handles' : 'does not handle'} it`
        );
      }
    };

    // Leader→follower: `decoded` = iOS acts on it, `unknown` = iOS ignores it.
    for (const [variant, entry] of Object.entries(LEADER_TO_FOLLOWER_CORPUS)) {
      check('Leader→Follower', docVariants.l2fFollowers, variant, entry.ios === 'decoded');
    }
    // Follower→leader: `decoded` = iOS can originate it, `undecodable` = it is
    // a TS-only variant iOS never sends.
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
