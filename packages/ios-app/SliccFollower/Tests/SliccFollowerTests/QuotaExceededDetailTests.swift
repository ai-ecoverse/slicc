import Foundation
import XCTest

@testable import SliccFollower




final class QuotaExceededDetailTests: XCTestCase {
    
    private static let adobe429 = """
        429 {"error":{"type":"quota_exceeded","message":"Weekly budget has been fully used. \
        Resets on 2026-09-14. You can also connect your own LLM provider.",\
        "resets_at":"2026-09-14T00:00:00.000Z"}}
        """

    func testParsesTheAdobeEnvelope() {
        let detail = QuotaExceededDetail(content: Self.adobe429)
        XCTAssertEqual(detail?.message, "Weekly budget has been fully used. Resets on 2026-09-14.")
        XCTAssertEqual(detail?.resetsAt, "2026-09-14T00:00:00.000Z")
    }

    func testDropsTheConnectYourOwnProviderSentence() {
        
        
        let detail = QuotaExceededDetail(content: Self.adobe429)
        XCTAssertEqual(detail?.message.contains("connect your own"), false)
    }

    func testParsesThroughAScoopWrapperPrefix() {
        let wrapped = "Scoop \"digest\" failed with unrecoverable error: \(Self.adobe429)"
        XCTAssertEqual(QuotaExceededDetail(content: wrapped)?.resetsAt, "2026-09-14T00:00:00.000Z")
    }

    func testRejectsNeighbouringErrorFamilies() {
        XCTAssertNil(
            QuotaExceededDetail(
                content: "403 {\"error\":{\"type\":\"forbidden\",\"message\":\"Model not allowed\"}}"
            ))
        XCTAssertNil(QuotaExceededDetail(content: "Adobe session expired — please log in again"))
        XCTAssertNil(QuotaExceededDetail(content: "429 Too Many Requests"))
        XCTAssertNil(QuotaExceededDetail(content: ""))
    }

    func testFallsBackToGenericCopyRatherThanRawJson() {
        let detail = QuotaExceededDetail(content: "429 {\"error\":{\"type\":\"quota_exceeded\"}}")
        XCTAssertEqual(detail?.message, QuotaExceededDetail.fallbackMessage)
        XCTAssertNil(detail?.resetsAt)
    }

    func testSurvivesATruncatedEnvelope() {
        
        
        let detail = QuotaExceededDetail(
            content: "429 {\"error\":{\"type\":\"quota_exceeded\",\"message\":\"Wee")
        XCTAssertEqual(detail?.message, QuotaExceededDetail.fallbackMessage)
    }

    func testSpellsOutAResetTheProseOmits() {
        let detail = QuotaExceededDetail(
            content: """
                429 {"error":{"type":"quota_exceeded","message":"Your budget is used up.",\
                "resets_at":"2026-09-14T00:00:00.000Z"}}
                """)
        XCTAssertEqual(detail?.body.hasPrefix("Your budget is used up. Resets on "), true)
    }

    func testNeverStatesTheResetTwice() {
        let body = QuotaExceededDetail(content: Self.adobe429)?.body
        XCTAssertEqual(body, "Weekly budget has been fully used. Resets on 2026-09-14.")
    }

    func testLeavesTheBodyAloneWhenTheResetInstantIsUnparseable() {
        let detail = QuotaExceededDetail(
            content: """
                429 {"error":{"type":"quota_exceeded","message":"Your budget is used up.",\
                "resets_at":"soon"}}
                """)
        XCTAssertEqual(detail?.body, "Your budget is used up.")
    }
}
