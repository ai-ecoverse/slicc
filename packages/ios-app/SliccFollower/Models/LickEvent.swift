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
enum FollowerLickType: String, Codable {
    case navigate
    case discovery
}

/// A lick originating on this follower.
struct LickEvent: Codable, Equatable {
    let type: FollowerLickType
    /// ISO-8601, matching the browser follower's `new Date().toISOString()`.
    let timestamp: String
    /// Free-form payload the cone reads. For `navigate` this is the handoff
    /// descriptor (`url`, `verb`, `target`, and optional `instruction`,
    /// `branch`, `path`, `title`).
    let body: AnyCodable?

    /// `navigate`: the page URL whose response advertised the handoff rel.
    var navigateUrl: String?
    /// `discovery`: origin, artifact kind, and manifest URL.
    var discoveryOrigin: String?
    var discoveryKind: String?
    var discoveryUrl: String?
    /// Always nil on the wire from a follower — the leader strips it anyway
    /// (`const { targetScoop: _droppedTarget, ...rest }`). Modelled so the
    /// omission is visible rather than looking like an oversight.
    var targetScoop: String?

    init(
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

    /// Build the navigate lick for a recognised handoff, matching the body the
    /// browser follower's navigate watcher sends
    /// (`ui/follower-navigate-watcher.ts`).
    static func navigate(
        pageURL: String,
        match: HandoffMatch,
        title: String? = nil,
        timestamp: String = ISO8601DateFormatter().string(from: Date())
    ) -> LickEvent {
        // Raw values, not pre-wrapped: `AnyCodable` wraps nested containers
        // itself, and handing it a dictionary of `AnyCodable` double-wraps.
        var body: [String: Any] = [
            "url": pageURL,
            "verb": match.verb.rawValue,
            "target": match.target,
        ]
        if let instruction = match.instruction { body["instruction"] = instruction }
        if let branch = match.branch { body["branch"] = branch }
        if let path = match.path { body["path"] = path }
        if let title, !title.isEmpty { body["title"] = title }
        return LickEvent(
            type: .navigate,
            timestamp: timestamp,
            body: AnyCodable(body),
            navigateUrl: pageURL)
    }
}
