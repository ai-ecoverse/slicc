import Foundation

/// Per-session sampling state: the stable session id, the resolved weight,
/// and the cached selection decision.
///
/// Mirrors helix-rum-js: `isSelected` is computed once from
/// `weight > 0 && random * weight < 1` and reused for the lifetime of the
/// session. Construct one instance per process/session and share it.
public struct SamplingSession {
    /// Stable 9-char session id (sourced externally; this type does not
    /// generate it).
    public let id: String

    /// Sampling weight in effect for this session.
    public let weight: Int

    /// Cached selection decision. `true` means pings should be emitted.
    public let isSelected: Bool

    /// Construct a session, computing ``isSelected`` exactly once from the
    /// supplied ``RandomSource``.
    public init(
        id: String,
        config: SamplingConfig,
        random: RandomSource = SystemRandomSource()
    ) {
        self.id = id
        self.weight = config.weight
        self.isSelected = SamplingSession.computeIsSelected(
            weight: config.weight,
            random: random
        )
    }

    /// Pure selection predicate matching helix-rum-js:
    /// `weight > 0 && random * weight < 1`.
    public static func computeIsSelected(weight: Int, random: RandomSource) -> Bool {
        guard weight > 0 else { return false }
        return random.nextUnitDouble() * Double(weight) < 1.0
    }
}
