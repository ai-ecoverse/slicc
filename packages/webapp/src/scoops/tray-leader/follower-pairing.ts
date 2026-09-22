/**
 * Fold the two followers one Mac brings when `slicc <url> follow --computer`
 * is running into a single agent-facing roster entry (#3260).
 *
 * `--computer` spawns a headless `Sliccstart --computer-follow` beside the CLI.
 * Both dial the same leader, so without this the Mac shows up twice: a
 * `follower-…` advertising `exec` and a `sliccstart-computer` advertising
 * `computer`. The agent then has to know which of the two to point
 * `computer add ssh` at, and nothing tells it they are the same machine.
 *
 * Both peers carry the same CLI-minted `hello.pairId`, which is what lets the
 * leader say "same machine" without guessing from hostnames or MOTDs.
 *
 * Pure on purpose: the registry owns the follower map, this owns the rule.
 */

/** The `hello` facts pairing needs. One connected follower. */
export interface PairablePeer {
  bootstrapId: string;
  /** `hello.capabilities.exec` — runs shell commands (the CLI). */
  exec: boolean;
  /** `hello.capabilities.computer` — native capture/input (the launcher). */
  computer: boolean;
  /** `hello.pairId`, when the peer sent one. */
  pairId?: string;
}

/** Who absorbed whom, resolved over every connected follower. */
export interface FollowerPairing {
  /** Absorbed peer → the primary it folded into. Absorbed peers stay off the roster. */
  readonly absorbedBy: ReadonlyMap<string, string>;
  /**
   * Primary peer → the peer folded into it, whatever that peer can do. The
   * inverse of `absorbedBy`; what lets the primary's roster entry carry what
   * its partner said on `hello` (the MOTD naming a missing grant).
   */
  readonly partner: ReadonlyMap<string, string>;
  /**
   * Primary peer → the absorbed peer that actually serves `computer.native.*`.
   * A subset of `partner`: only a partner advertising `computer` lends the
   * primary a screen. An ungranted launcher still folds, but routing capture at
   * it would re-create the false claim #3387 removed.
   */
  readonly computerPartner: ReadonlyMap<string, string>;
}

const EMPTY: FollowerPairing = {
  absorbedBy: new Map(),
  partner: new Map(),
  computerPartner: new Map(),
};

/**
 * Resolve the pairs among `peers`.
 *
 * A group is the set of peers sharing one non-empty `pairId`. Inside a group:
 *
 * - the **primary** is the single `exec` peer — the CLI, which is what the
 *   agent addresses with `ssh` and what `computer add ssh` probes;
 * - the **partner** is a non-`exec` peer — the launcher — whose own roster
 *   entry disappears. It folds on the shared token alone, not on whether it can
 *   capture right now: the launcher advertises `computer` as its Screen
 *   Recording grant actually stands (#3387), and an ungranted Mac is still one
 *   machine. Only a `computer` partner lends the primary its screen
 *   (`computerPartner`); a capture-capable one is preferred when there is a
 *   choice.
 *
 * Deliberately conservative — anything ambiguous folds nothing, leaving
 * today's two-entry behaviour rather than silently hiding a machine:
 *
 * - no `exec` peer (the CLI is down, or `follow` ran with no runner) — the
 *   launcher keeps its own entry, which is how `--computer` in ui mode and a
 *   plain Sliccstart both stay addressable;
 * - more than one `exec` peer on a token — two CLIs cannot both be the same
 *   machine, so neither is trusted to speak for it;
 * - extra non-`exec` peers beyond the partner — a leftover from a restart is
 *   left visible instead of being folded into a machine it may not belong to.
 *
 * A peer that advertises BOTH capabilities is already one entry and is never
 * a partner; it can still be a group's primary.
 */
export function resolveFollowerPairs(peers: Iterable<PairablePeer>): FollowerPairing {
  const groups = new Map<string, PairablePeer[]>();
  for (const peer of peers) {
    const pairId = peer.pairId?.trim();
    if (!pairId) continue;
    const group = groups.get(pairId);
    if (group) group.push(peer);
    else groups.set(pairId, [peer]);
  }
  if (groups.size === 0) return EMPTY;

  const absorbedBy = new Map<string, string>();
  const partnerOf = new Map<string, string>();
  const computerPartner = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const primaries = group.filter((peer) => peer.exec);
    if (primaries.length !== 1) continue;
    const primary = primaries[0];
    const candidates = group.filter((peer) => !peer.exec);
    const partner = candidates.find((peer) => peer.computer) ?? candidates[0];
    if (!partner) continue;
    absorbedBy.set(partner.bootstrapId, primary.bootstrapId);
    partnerOf.set(primary.bootstrapId, partner.bootstrapId);
    if (partner.computer) computerPartner.set(primary.bootstrapId, partner.bootstrapId);
  }
  if (absorbedBy.size === 0) return EMPTY;
  return { absorbedBy, partner: partnerOf, computerPartner };
}
