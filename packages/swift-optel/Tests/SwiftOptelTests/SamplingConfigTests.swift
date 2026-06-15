import XCTest
@testable import SwiftOptel

final class SamplingConfigTests: XCTestCase {
    func testNilRateUsesDefaultWeight() {
        XCTAssertEqual(SamplingConfig(rate: nil).weight, 100)
    }

    func testRateAliasOnMapsToOne() {
        XCTAssertEqual(SamplingConfig(rate: "on").weight, 1)
    }

    func testRateAliasOffMapsToZero() {
        XCTAssertEqual(SamplingConfig(rate: "off").weight, 0)
    }

    func testRateAliasHighMapsToTen() {
        XCTAssertEqual(SamplingConfig(rate: "high").weight, 10)
    }

    func testRateAliasLowMapsToThousand() {
        XCTAssertEqual(SamplingConfig(rate: "low").weight, 1000)
    }

    func testNumericStringFallsBackToDefault() {
        // helix-rum-js only recognizes the four aliases; numeric strings are
        // not a supported rate format and must resolve to the default weight.
        XCTAssertEqual(SamplingConfig(rate: "0").weight, 100)
        XCTAssertEqual(SamplingConfig(rate: "1").weight, 100)
        XCTAssertEqual(SamplingConfig(rate: "42").weight, 100)
        XCTAssertEqual(SamplingConfig(rate: "500").weight, 100)
    }

    func testUnknownStringFallsBackToDefault() {
        XCTAssertEqual(SamplingConfig(rate: "bogus").weight, 100)
        XCTAssertEqual(SamplingConfig(rate: "").weight, 100)
        XCTAssertEqual(SamplingConfig(rate: "3.14").weight, 100)
    }

    func testNumericInitPreservesWeight() {
        XCTAssertEqual(SamplingConfig(weight: 42).weight, 42)
        XCTAssertEqual(SamplingConfig(weight: 0).weight, 0)
    }

    func testDefaultConfigUsesDefaultWeight() {
        XCTAssertEqual(SamplingConfig.default.weight, SamplingConfig.defaultWeight)
        XCTAssertEqual(SamplingConfig.defaultWeight, 100)
    }

    func testParseWeightStaticAPI() {
        XCTAssertEqual(SamplingConfig.parseWeight(from: "high"), 10)
        XCTAssertEqual(SamplingConfig.parseWeight(from: "200"), 100)
        XCTAssertEqual(SamplingConfig.parseWeight(from: nil), 100)
    }
}
