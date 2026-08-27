import Foundation

/// The `TRAY_SUPERSEDED` chase, shared by both iOS attach loops.
///
/// When a leader's tab reconnects it mints a fresh tray and tells the old one it
/// has been superseded, so every later attach on the old join URL answers HTTP
/// 409 `{ action: "fail", code: "TRAY_SUPERSEDED", joinUrl: <replacement> }`,
/// and stamps the same address as an RFC 5829 `successor-version` link
/// (`SupersedeLink`) that outlives any change to that body shape.
/// That is a redirect, not a dead end: the follower re-attaches to `joinUrl`
/// with a fresh controller id (the old id belongs to the old tray's roster).
///
/// The bound exists because the replacement can itself be superseded, and a
/// mis-set `supersededByJoinUrl` could point back at its own tray. Kept equal
/// to `MAX_SUPERSEDE_REDIRECTS` / `SUPERSEDE_REDIRECT_DELAY_MS` in
/// `packages/webapp/src/scoops/tray-webrtc.ts` and `maxSupersedeRetries` in
/// `packages/slicc-cli/internal/tray/conn.go`.
public enum SupersedeRedirect {
    public static let maxRedirects = 5
    public static let delaySeconds: TimeInterval = 1.0

    public enum Outcome: Equatable {
        /// A terminal outcome — the caller reports `plan.error` / `plan.code`.
        case terminal
        /// Re-attach here with a fresh controller id.
        case follow(URL)
        /// Bound reached; treated as terminal but named so callers can say why.
        case exhausted
        /// The hub sent a replacement that is not a URL.
        case invalidJoinUrl
    }

    /// Decide what an attach plan means for the chase.
    ///
    /// Gated on the replacement address alone, not on `plan.code`: the plan
    /// only carries one when the hub said the tray moved — through the body's
    /// `TRAY_SUPERSEDED` or the `successor-version` link (#1957) — and keying
    /// off the failure code instead is what let #1956 read a redirect as a
    /// malformed reply. A future body that calls this `redirect` rather than
    /// `fail` keeps working here unchanged.
    public static func outcome(
        for plan: FollowerAttachPlan, redirectsFollowed: Int
    ) -> Outcome {
        guard let raw = plan.supersededByJoinUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty
        else { return .terminal }

        guard redirectsFollowed < maxRedirects else { return .exhausted }
        // `URL(string:)` accepts bare relative strings, which would resolve
        // against nothing and dial an unusable request; a replacement tray is
        // always absolute.
        guard let url = URL(string: raw), url.scheme != nil, url.host != nil else {
            return .invalidJoinUrl
        }
        return .follow(url)
    }

    /// Message for the terminal cases, deliberately free of the join URL —
    /// it carries the session secret.
    public static func failureMessage(for outcome: Outcome) -> String? {
        switch outcome {
        case .exhausted:
            return
                "This session moved \(maxRedirects) times without settling "
                + "(possible redirect loop)."
        case .invalidJoinUrl:
            return "This session moved, but the replacement address was unusable."
        case .terminal, .follow:
            return nil
        }
    }
}
