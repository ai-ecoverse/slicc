import Foundation
import XCTest

@testable import SliccFollower




final class ExhaustedBudgetDetailTests: XCTestCase {
    
    private static let adobe429 = """
        429 {"error":{"type":"quota_exceeded","message":"Weekly budget has been fully used. \
        Resets on 2026-09-14. You can also connect your own LLM provider.",\
        "resets_at":"2026-09-14T00:00:00.000Z"}}
        """
    private static let grok403 = """
        403 {"code":"The caller does not have permission to execute the specified operation",\
        "error":"You have either run out of available resources or do not have an active Grok \
        subscription. Manage your subscription at https:
        """

    func testParsesTheAdobeEnvelope() {
        let detail = ExhaustedBudgetDetail(content: Self.adobe429)
        XCTAssertEqual(detail?.message, "Weekly budget has been fully used. Resets on 2026-09-14.")
        XCTAssertEqual(detail?.resetsAt, "2026-09-14T00:00:00.000Z")
    }

    func testDropsTheConnectYourOwnProviderSentence() {
        // The leader replaces that sentence with CTAs; the follower has none,
        // but repeating advice the reader cannot act on here is still noise.
        let detail = ExhaustedBudgetDetail(content: Self.adobe429)
        XCTAssertEqual(detail?.message.contains("connect your own"), false)
    }

    func testParsesThroughAScoopWrapperPrefix() {
        let wrapped = "Scoop \"digest\" failed with unrecoverable error: \(Self.adobe429)"
        XCTAssertEqual(ExhaustedBudgetDetail(content: wrapped)?.resetsAt, "2026-09-14T00:00:00.000Z")
    }

    func testParsesGrokCreditRefusalWithoutAdapterNoise() {
        let detail = ExhaustedBudgetDetail(content: Self.grok403)
        XCTAssertEqual(
            detail?.message,
            "Your Grok account has run out of credits or does not have an active subscription."
        )
        XCTAssertNil(detail?.resetsAt)
        XCTAssertEqual(detail?.message.contains("403"), false)
        XCTAssertEqual(detail?.message.contains("grok.com"), false)
    }

    func testParsesWrappedGrokCreditRefusal() {
        let wrapped = "Scoop \"digest\" failed with unrecoverable error: \(Self.grok403)"
        XCTAssertEqual(ExhaustedBudgetDetail(content: wrapped)?.message.contains("Grok"), true)
    }

    func testRejectsNeighbouringErrorFamilies() {
        XCTAssertNil(
            ExhaustedBudgetDetail(
                content: "403 {\"error\":{\"type\":\"forbidden\",\"message\":\"Model not allowed\"}}"
            ))
        XCTAssertNil(ExhaustedBudgetDetail(content: "Adobe session expired — please log in again"))
        XCTAssertNil(ExhaustedBudgetDetail(content: "429 Too Many Requests"))
        XCTAssertNil(ExhaustedBudgetDetail(content: "403 Forbidden"))
        
        XCTAssertNil(
            ExhaustedBudgetDetail(
                content: "403 You have run out of credits and need a subscription to continue."
            ))
        XCTAssertNil(ExhaustedBudgetDetail(content: ""))
    }

    func testFallsBackToGenericCopyRatherThanRawJson() {
        let detail = ExhaustedBudgetDetail(content: "429 {\"error\":{\"type\":\"quota_exceeded\"}}")
        XCTAssertEqual(detail?.message, ExhaustedBudgetDetail.fallbackMessage)
        XCTAssertNil(detail?.resetsAt)
    }

    func testSurvivesATruncatedEnvelope() {
        
        
        let detail = ExhaustedBudgetDetail(
            content: "429 {\"error\":{\"type\":\"quota_exceeded\",\"message\":\"Wee")
        XCTAssertEqual(detail?.message, ExhaustedBudgetDetail.fallbackMessage)
    }

    func testSpellsOutAResetTheProseOmits() {
        let detail = ExhaustedBudgetDetail(
            content: """
                429 {"error":{"type":"quota_exceeded","message":"Your budget is used up.",\
                "resets_at":"2026-09-14T00:00:00.000Z"}}
                """)
        XCTAssertEqual(detail?.body.hasPrefix("Your budget is used up. Resets on "), true)
    }

    func testNeverStatesTheResetTwice() {
        let body = ExhaustedBudgetDetail(content: Self.adobe429)?.body
        XCTAssertEqual(body, "Weekly budget has been fully used. Resets on 2026-09-14.")
    }

    func testLeavesTheBodyAloneWhenTheResetInstantIsUnparseable() {
        let detail = ExhaustedBudgetDetail(
            content: """
                429 {"error":{"type":"quota_exceeded","message":"Your budget is used up.",\
                "resets_at":"soon"}}
                """)
        XCTAssertEqual(detail?.body, "Your budget is used up.")
    }
}
