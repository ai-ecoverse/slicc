import Foundation
import XCTest

@testable import SliccTrayFollower

/// The `TRAY_SUPERSEDED` chase policy — pure decision logic over a
/// `FollowerAttachPlan`, with no network involved.
final class SupersedeRedirectTests: XCTestCase {

    /// A minimal `fail` attach plan carrying the given code and replacement URL.
    private func failPlan(code: String, joinUrl: String?) -> FollowerAttachPlan {
        FollowerAttachPlan(
            trayId: "tray-1",
            controllerId: "controller-1",
            participantCount: 1,
            leader: nil,
            action: .fail,
            code: code,
            retryAfterMs: nil,
            error: "superseded",
            bootstrap: nil,
            iceServers: nil,
            supersededByJoinUrl: joinUrl)
    }

    // MARK: - Constants

    func testConstants() {
        XCTAssertEqual(SupersedeRedirect.maxRedirects, 5)
        XCTAssertEqual(SupersedeRedirect.delaySeconds, 1.0)
    }

    // MARK: - Terminal outcomes

    func testNonSupersededCodeIsTerminal() {
        let plan = failPlan(code: "TRAY_EXPIRED", joinUrl: "https://hub.example/join")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .terminal)
    }

    func testSupersededWithoutJoinUrlIsTerminal() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: nil)
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .terminal)
    }

    func testSupersededWithWhitespaceJoinUrlIsTerminal() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "   \n  ")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .terminal)
    }

    // MARK: - Follow

    func testSupersededWithValidUrlFollows() throws {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "https://hub.example/join?secret=abc")
        let outcome = SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0)
        XCTAssertEqual(outcome, .follow(URL(string: "https://hub.example/join?secret=abc")!))
    }

    func testSupersededTrimsSurroundingWhitespaceBeforeFollowing() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "  https://hub.example/join  ")
        let outcome = SupersedeRedirect.outcome(for: plan, redirectsFollowed: 2)
        XCTAssertEqual(outcome, .follow(URL(string: "https://hub.example/join")!))
    }

    func testFollowIsAllowedUpToButNotAtTheBound() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "https://hub.example/join")
        // One below the bound still follows.
        guard case .follow = SupersedeRedirect.outcome(for: plan, redirectsFollowed: SupersedeRedirect.maxRedirects - 1) else {
            XCTFail("expected follow just below the bound")
            return
        }
    }

    // MARK: - Exhausted

    func testExhaustedAtTheBound() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "https://hub.example/join")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: SupersedeRedirect.maxRedirects), .exhausted)
    }

    func testExhaustedBeyondTheBound() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "https://hub.example/join")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 99), .exhausted)
    }

    // MARK: - Invalid replacement

    func testRelativeReplacementUrlIsInvalid() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "relative/path")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .invalidJoinUrl)
    }

    func testSchemeOnlyReplacementUrlIsInvalid() {
        // A scheme with no host is unusable for a dial.
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "https:///nohost")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .invalidJoinUrl)
    }

    // MARK: - failureMessage

    func testFailureMessageForExhausted() {
        let message = SupersedeRedirect.failureMessage(for: .exhausted)
        XCTAssertNotNil(message)
        XCTAssertTrue(message?.contains("\(SupersedeRedirect.maxRedirects)") == true)
    }

    func testFailureMessageForInvalidJoinUrl() {
        XCTAssertEqual(
            SupersedeRedirect.failureMessage(for: .invalidJoinUrl),
            "This session moved, but the replacement address was unusable.")
    }

    func testFailureMessageIsNilForNonTerminalNarration() {
        XCTAssertNil(SupersedeRedirect.failureMessage(for: .terminal))
        XCTAssertNil(SupersedeRedirect.failureMessage(for: .follow(URL(string: "https://hub.example")!)))
    }
}
