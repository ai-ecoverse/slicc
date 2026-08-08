import Foundation

// The generic `lick` envelope, mirroring `LickEvent` from
// `packages/shared-ts/src/agent-wire-types.ts` minus the two fields the leader
// stamps on receipt (`originFollowerId`, `originLabel` — see the `Omit<…>` on
// the `lick` message in `tray-sync-protocol.ts`).
//
// This mirror is deliberately partial. `LickEvent` carries ~30 optional fields
// spanning webhooks, cron, fswatch, sudo, workflow and preview, but the leader
// only accepts two lick types over the wire: `FORWARDABLE_TO_LEADER` in
// `lick-manager.ts` is `{navigate, discovery}`, and `handleFollowerLick`
// rejects anything else with a warning. So the fields modelled here are the
// ones those two types actually use. Encoding omits every nil, which keeps the
// envelope identical in shape to what the browser follower sends.

/// The lick types a follower may send to the leader.
///
/// Restricted to what the leader will accept. Adding a case here without
/// adding it to `FORWARDABLE_TO_LEADER` produces a lick the leader logs and
/// drops.
public enum FollowerLickType: String, Codable {
    case navigate
    case discovery
}

/// A lick originating on this follower.
public struct LickEvent: Codable, Equatable {
    public let type: FollowerLickType
    /// ISO-8601, matching the browser follower's `new Date().toISOString()`.
    public let timestamp: String
    /// Free-form payload the cone reads. For `navigate` this is the handoff
    /// descriptor (`url`, `verb`, `target`, and optional `instruction`,
    /// `branch`, `path`, `title`).
    public let body: AnyCodable?

    /// `navigate`: the page URL whose response advertised the handoff rel.
    public var navigateUrl: String?
    /// `discovery`: origin, artifact kind, and manifest URL.
    var discoveryOrigin: String?
    var discoveryKind: String?
    var discoveryUrl: String?
    /// Always nil on the wire from a follower — the leader strips it anyway
    /// (`const { targetScoop: _droppedTarget, ...rest }`). Modelled so the
    /// omission is visible rather than looking like an oversight.
    public var targetScoop: String?

    public init(
        type: FollowerLickType,
        timestamp: String,
        body: AnyCodable?,
        navigateUrl: String? = nil,
        discoveryOrigin: String? = nil,
        discoveryKind: String? = nil,
        discoveryUrl: String? = nil,
        targetScoop: String? = nil
    ) {
        self.type = type
        self.timestamp = timestamp
        self.body = body
        self.navigateUrl = navigateUrl
        self.discoveryOrigin = discoveryOrigin
        self.discoveryKind = discoveryKind
        self.discoveryUrl = discoveryUrl
        self.targetScoop = targetScoop
    }
}
