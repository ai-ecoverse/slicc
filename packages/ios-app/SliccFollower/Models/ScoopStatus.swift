import Foundation
import SliccTrayKit

enum ScoopLifecycle: String, CaseIterable, Equatable, Sendable {
    case working
    /// Waiting on or streaming from the model, as opposed to running a tool.
    case thinking
    /// The turn ended and the composer is the user's.
    case awaiting
    case broken
    case initializing
    case idle
    case unknown

    /// Unknown strings fall to `.unknown` rather than failing to decode, which
    /// is what lets a leader add states (as `thinking` and `awaiting` were)
    /// without stranding followers that predate them.
    init(state: String?) {
        self = state.flatMap(Self.init(rawValue:)) ?? .unknown
    }

    /// Whether the agent is mid-turn. `thinking` and `working` are one turn's
    /// two halves, so anything keyed on "busy" must count both.
    var isBusy: Bool {
        self == .working || self == .thinking
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
