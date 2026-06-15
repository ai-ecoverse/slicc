import XCTest
@testable import SwiftOptel

final class OptelEnvConfigTests: XCTestCase {
    // MARK: - resolveRate

    func testResolveRateEnvWinsOverExplicit() {
        XCTAssertEqual(
            OptelEnvConfig.resolveRate(explicit: "off", environment: ["OPTEL_RATE": "on"]),
            "on"
        )
        XCTAssertEqual(
            OptelEnvConfig.resolveRate(explicit: nil, environment: ["OPTEL_RATE": "on"]),
            "on"
        )
    }

    func testResolveRateUsesExplicitWhenEnvAbsent() {
        XCTAssertEqual(
            OptelEnvConfig.resolveRate(explicit: "high", environment: [:]),
            "high"
        )
        XCTAssertEqual(
            OptelEnvConfig.resolveRate(explicit: "low", environment: ["OTHER": "x"]),
            "low"
        )
    }

    func testResolveRateReturnsNilWhenBothAbsent() {
        XCTAssertNil(OptelEnvConfig.resolveRate(explicit: nil, environment: [:]))
    }

    func testResolveRateEmptyEnvFallsBackToExplicit() {
        // Empty env value is treated as "not set" so an explicitly cleared
        // shell variable doesn't accidentally wipe a baked-in rate.
        XCTAssertEqual(
            OptelEnvConfig.resolveRate(explicit: "on", environment: ["OPTEL_RATE": ""]),
            "on"
        )
        XCTAssertNil(
            OptelEnvConfig.resolveRate(explicit: nil, environment: ["OPTEL_RATE": ""])
        )
    }

    func testResolveRatePassesThroughEachAlias() {
        // Each helix-rum-js alias is returned verbatim so the downstream
        // SamplingConfig parser produces the canonical weight.
        let expectedWeights: [String: Int] = ["on": 1, "off": 0, "high": 10, "low": 1000]
        for (alias, expectedWeight) in expectedWeights {
            XCTAssertEqual(
                OptelEnvConfig.resolveRate(explicit: nil, environment: ["OPTEL_RATE": alias]),
                alias
            )
            XCTAssertEqual(SamplingConfig(rate: alias).weight, expectedWeight)
        }
    }

    func testResolveRatePassesNumericAndGarbageThroughForDefaultFallback() {
        // Non-alias env values still override the explicit value; the final
        // weight is the helix-rum-js default of 100 via SamplingConfig.
        for raw in ["42", "0.5", "banana", "bogus"] {
            let resolved = OptelEnvConfig.resolveRate(
                explicit: "on",
                environment: ["OPTEL_RATE": raw]
            )
            XCTAssertEqual(resolved, raw)
            XCTAssertEqual(SamplingConfig(rate: resolved).weight, 100)
        }
    }

    // MARK: - resolveDebugLogging

    func testResolveDebugLoggingTruthyValues() {
        for raw in ["1", "true", "on", "yes", "TRUE", "On", "YES"] {
            XCTAssertTrue(
                OptelEnvConfig.resolveDebugLogging(environment: ["OPTEL_DEBUG": raw]),
                "expected truthy parsing for \(raw)"
            )
        }
    }

    func testResolveDebugLoggingFalseyValues() {
        for raw in ["0", "false", "off", "no", "", "garbage", "2"] {
            XCTAssertFalse(
                OptelEnvConfig.resolveDebugLogging(environment: ["OPTEL_DEBUG": raw]),
                "expected falsey parsing for \(raw)"
            )
        }
    }

    func testResolveDebugLoggingMissingKeyIsFalse() {
        XCTAssertFalse(OptelEnvConfig.resolveDebugLogging(environment: [:]))
        XCTAssertFalse(OptelEnvConfig.resolveDebugLogging(environment: ["OTHER": "1"]))
    }

    // MARK: - Public constants

    func testEnvKeysMatchDocumentedSpec() {
        XCTAssertEqual(OptelEnvConfig.rateKey, "OPTEL_RATE")
        XCTAssertEqual(OptelEnvConfig.debugKey, "OPTEL_DEBUG")
    }
}
