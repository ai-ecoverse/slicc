export interface PairablePeer {
  bootstrapId: string;

  exec: boolean;

  computer: boolean;

  pairId?: string;
}

export interface FollowerPairing {
  readonly absorbedBy: ReadonlyMap<string, string>;

  readonly partner: ReadonlyMap<string, string>;

  readonly computerPartner: ReadonlyMap<string, string>;
}

const EMPTY: FollowerPairing = {
  absorbedBy: new Map(),
  partner: new Map(),
  computerPartner: new Map(),
};

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
