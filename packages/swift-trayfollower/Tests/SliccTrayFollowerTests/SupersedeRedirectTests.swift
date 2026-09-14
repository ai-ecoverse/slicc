import Foundation
import XCTest

@testable import SliccTrayFollower



final class SupersedeRedirectTests: XCTestCase {

    
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

    

    func testConstants() {
        XCTAssertEqual(SupersedeRedirect.maxRedirects, 5)
        XCTAssertEqual(SupersedeRedirect.delaySeconds, 1.0)
    }

    

    func testPlanWithoutAReplacementIsTerminal() {
        let plan = failPlan(code: "TRAY_EXPIRED", joinUrl: nil)
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .terminal)
    }

    
    
    
    
    
    func testAnyPlanCarryingAReplacementIsFollowed() {
        let plan = failPlan(code: "SOME_FUTURE_CODE", joinUrl: "https://hub.example/join/b")
        XCTAssertEqual(
            SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0),
            .follow(URL(string: "https://hub.example/join/b")!))
    }

    func testSupersededWithoutJoinUrlIsTerminal() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: nil)
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .terminal)
    }

    func testSupersededWithWhitespaceJoinUrlIsTerminal() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "   \n  ")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .terminal)
    }

    

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
        
        guard case .follow = SupersedeRedirect.outcome(for: plan, redirectsFollowed: SupersedeRedirect.maxRedirects - 1) else {
            XCTFail("expected follow just below the bound")
            return
        }
    }

    

    func testExhaustedAtTheBound() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "https://hub.example/join")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: SupersedeRedirect.maxRedirects), .exhausted)
    }

    func testExhaustedBeyondTheBound() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "https://hub.example/join")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 99), .exhausted)
    }

    

    func testRelativeReplacementUrlIsInvalid() {
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "relative/path")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .invalidJoinUrl)
    }

    func testSchemeOnlyReplacementUrlIsInvalid() {
        
        let plan = failPlan(code: "TRAY_SUPERSEDED", joinUrl: "https:///nohost")
        XCTAssertEqual(SupersedeRedirect.outcome(for: plan, redirectsFollowed: 0), .invalidJoinUrl)
    }

    

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
