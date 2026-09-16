import XCTest

@testable import SwiftOptel

final class OptelEnvConfigTests: XCTestCase {

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

        XCTAssertEqual(
            OptelEnvConfig.resolveRate(explicit: "on", environment: ["OPTEL_RATE": ""]),
            "on"
        )
        XCTAssertNil(
            OptelEnvConfig.resolveRate(explicit: nil, environment: ["OPTEL_RATE": ""])
        )
    }

    func testResolveRatePassesThroughEachAlias() {

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

        for raw in ["42", "0.5", "banana", "bogus"] {
            let resolved = OptelEnvConfig.resolveRate(
                explicit: "on",
                environment: ["OPTEL_RATE": raw]
            )
            XCTAssertEqual(resolved, raw)
            XCTAssertEqual(SamplingConfig(rate: resolved).weight, 100)
        }
    }

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

    func testEnvKeysMatchDocumentedSpec() {
        XCTAssertEqual(OptelEnvConfig.rateKey, "OPTEL_RATE")
        XCTAssertEqual(OptelEnvConfig.debugKey, "OPTEL_DEBUG")
    }
}
