import Foundation

/// Source of uniformly distributed `Double` values in `[0, 1)`.
///
/// Abstracted so sampling decisions can be made deterministic in tests by
/// injecting a fixed/stubbed RNG. Mirrors the JS `Math.random()` contract.
public protocol RandomSource {
    /// Returns a `Double` in `[0, 1)`.
    func nextUnitDouble() -> Double
}

/// Default ``RandomSource`` backed by the standard library's system RNG.
public struct SystemRandomSource: RandomSource {
    public init() {}

    public func nextUnitDouble() -> Double {
        Double.random(in: 0..<1)
    }
}
