import Foundation
import SliccTrayKit

enum ScoopLifecycle: String, CaseIterable, Equatable, Sendable {
    case working
    case broken
    case initializing
    case idle
    case unknown

    init(state: String?) {
        self = state.flatMap(Self.init(rawValue:)) ?? .unknown
    }
}

/// The optional REFINEMENT of `ScoopLifecycle`, carrying the agent avatar's
/// expression grammar (`ScoopSummary.activity`).
///
/// It is a separate field on the wire, not a widening of `state`, precisely so
/// that a follower which predates it — including this one, before it learned
/// these values — keeps rendering `state` exactly as it always did. An
/// unrecognised value decodes to `nil` and the lifecycle alone decides, which
/// is the escape hatch that makes the NEXT refinement free as well.
enum ScoopActivity: String, CaseIterable, Equatable, Sendable {
    /// Busy waiting on or streaming from the model.
    case thinking
    /// Busy running a tool call.
    case tool
    /// Idle because the turn ended; the composer is the user's.
    case awaiting

    init?(activity: String?) {
        guard let activity, let parsed = Self(rawValue: activity) else { return nil }
        self = parsed
    }
}

struct ScoopStatus: Equatable, Sendable {
    static let nearLimitThreshold = 75.0

    let lifecycle: ScoopLifecycle
    let fullness: Double?

    init(state: String?, fill: Double?) {
        lifecycle = ScoopLifecycle(state: state)
        fullness = fill.map { value in
            value.isFinite ? min(100, max(0, value)) : 0
        }
    }

    var isNearLimit: Bool {
        fullness.map { $0 >= Self.nearLimitThreshold } ?? false
    }

    func accessibilityPhrase(label: String) -> String {
        let fillPhrase =
            fullness.map { "\(Int($0.rounded()))% context fill" }
            ?? "context fill unknown"
        return "\(label): \(lifecycle.rawValue), \(fillPhrase)"
    }
}

extension ScoopSummary {
    var status: ScoopStatus {
        ScoopStatus(state: state, fill: fill)
    }
}
