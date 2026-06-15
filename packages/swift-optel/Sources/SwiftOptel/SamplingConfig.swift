import Foundation

/// Resolved sampling configuration: the integer weight that drives the
/// per-session selection coin flip.
///
/// Mirrors helix-rum-js exactly: only the rate aliases (`on`, `off`, `high`,
/// `low`) map to specific weights; anything else — including numeric strings
/// and `nil` — falls back to the default weight of `100`.
public struct SamplingConfig: Equatable {
    /// Sampling weight. `0` disables sampling; higher values reduce the
    /// probability of selection (`1 / weight`).
    public let weight: Int

    /// Default helix-rum-js weight used when no rate was supplied.
    public static let defaultWeight: Int = 100

    /// Default configuration (`weight = 100`).
    public static let `default` = SamplingConfig(weight: defaultWeight)

    public init(weight: Int) {
        self.weight = weight
    }

    /// Build a config from a rate string. Only the `on`/`off`/`high`/`low`
    /// aliases are recognized; `nil` and every other value (including numeric
    /// strings) fall back to ``SamplingConfig/defaultWeight``.
    public init(rate: String?) {
        self.weight = SamplingConfig.parseWeight(from: rate)
    }

    /// Resolve a rate string to its integer weight, matching the helix-rum-js
    /// `rateValue` table.
    public static func parseWeight(from rate: String?) -> Int {
        guard let rate else { return defaultWeight }
        switch rate {
        case "on": return 1
        case "off": return 0
        case "high": return 10
        case "low": return 1000
        default: return defaultWeight
        }
    }
}
