import XCTest

@testable import SwiftOptel

private struct FixedRandom: RandomSource {
    let value: Double
    func nextUnitDouble() -> Double { value }
}

private final class CountingRandom: RandomSource {
    var calls = 0
    private let values: [Double]

    init(values: [Double]) { self.values = values }

    func nextUnitDouble() -> Double {
        defer { calls += 1 }
        return values[min(calls, values.count - 1)]
    }
}

final class SamplingSessionTests: XCTestCase {

    func testWeightZeroNeverSelects() {
        for value in [0.0, 0.0001, 0.5, 0.999_999] {
            let session = SamplingSession(
                id: "abc",
                config: SamplingConfig(weight: 0),
                random: FixedRandom(value: value)
            )
            XCTAssertFalse(session.isSelected, "weight=0 must never select (r=\(value))")
        }
    }

    func testOffRateNeverSelects() {
        let session = SamplingSession(
            id: "abc",
            config: SamplingConfig(rate: "off"),
            random: FixedRandom(value: 0)
        )
        XCTAssertFalse(session.isSelected)
    }

    func testNegativeWeightNeverSelects() {
        let session = SamplingSession(
            id: "x",
            config: SamplingConfig(weight: -5),
            random: FixedRandom(value: 0)
        )
        XCTAssertFalse(session.isSelected)
    }

    func testRandomZeroAlwaysSelectsForPositiveWeights() {
        for weight in [1, 10, 100, 1000] {
            let session = SamplingSession(
                id: "abc",
                config: SamplingConfig(weight: weight),
                random: FixedRandom(value: 0)
            )
            XCTAssertTrue(session.isSelected, "weight=\(weight), r=0 must select")
        }
    }

    func testWeightOneSelectsForAnyRandomBelowOne() {
        for value in [0.0, 0.5, 0.999_999] {
            let session = SamplingSession(
                id: "x",
                config: SamplingConfig(rate: "on"),
                random: FixedRandom(value: value)
            )
            XCTAssertTrue(session.isSelected, "weight=1, r=\(value) must select")
        }
    }

    func testWeight10BoundarySelection() {

        XCTAssertTrue(makeSession(weight: 10, random: 0.099).isSelected)
        XCTAssertFalse(makeSession(weight: 10, random: 0.1).isSelected)
        XCTAssertFalse(makeSession(weight: 10, random: 0.2).isSelected)
    }

    func testWeight100BoundarySelection() {

        XCTAssertTrue(makeSession(weight: 100, random: 0.009).isSelected)
        XCTAssertFalse(makeSession(weight: 100, random: 0.01).isSelected)
        XCTAssertFalse(makeSession(weight: 100, random: 0.5).isSelected)
    }

    func testWeight1000BoundarySelection() {

        XCTAssertTrue(makeSession(weight: 1000, random: 0.0009).isSelected)
        XCTAssertFalse(makeSession(weight: 1000, random: 0.001).isSelected)
        XCTAssertFalse(makeSession(weight: 1000, random: 0.5).isSelected)
    }

    func testIsSelectedComputedOnlyOnce() {

        let rng = CountingRandom(values: [0.0, 0.999])
        let session = SamplingSession(
            id: "x",
            config: SamplingConfig(weight: 10),
            random: rng
        )
        XCTAssertTrue(session.isSelected)
        XCTAssertTrue(session.isSelected)
        XCTAssertEqual(rng.calls, 1, "RNG must be consulted exactly once per session")
    }

    func testSessionRetainsIdAndWeight() {
        let session = SamplingSession(
            id: "abcdef123",
            config: SamplingConfig(weight: 100),
            random: FixedRandom(value: 0.5)
        )
        XCTAssertEqual(session.id, "abcdef123")
        XCTAssertEqual(session.weight, 100)
    }

    func testComputeIsSelectedMatchesFormula() {
        XCTAssertFalse(SamplingSession.computeIsSelected(weight: 0, random: FixedRandom(value: 0)))
        XCTAssertTrue(SamplingSession.computeIsSelected(weight: 1, random: FixedRandom(value: 0.5)))
        XCTAssertFalse(SamplingSession.computeIsSelected(weight: 100, random: FixedRandom(value: 0.5)))
    }

    private func makeSession(weight: Int, random: Double) -> SamplingSession {
        SamplingSession(
            id: "x",
            config: SamplingConfig(weight: weight),
            random: FixedRandom(value: random)
        )
    }
}
