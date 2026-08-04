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
