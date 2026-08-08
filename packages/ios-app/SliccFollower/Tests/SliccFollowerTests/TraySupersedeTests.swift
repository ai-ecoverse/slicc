import Foundation
import XCTest

@testable import SliccTrayFollower
@testable import SliccTrayKit

/// A leader tab that reconnects mints a fresh tray and marks the old one
/// superseded, so every later attach on the old join URL answers HTTP 409
/// `{ action: "fail", code: "TRAY_SUPERSEDED", joinUrl: <replacement> }`
/// (`packages/cloudflare-worker/src/session-tray.ts`).
///
/// iOS used to reject that as a malformed response — the code was absent from
/// the `fail` allowlist — and surfaced the raw body in Settings while the
/// browser follower (`tray-webrtc.ts`) and the Go CLI (`internal/tray/conn.go`)
/// both followed it. These tests pin the parity.
final class TraySupersedeTests: XCTestCase {

    // MARK: - Decoding

    private func attachPlan(
        statusCode: Int = 409,
        result: String
    ) async throws -> FollowerAttachPlan {
        let url = try XCTUnwrap(URL(string: "https://tray.example/join/old.secret"))
        let body = """
            {"trayId":"tray-1","controllerId":"ctrl-1","role":"follower",
             "leader":{"controllerId":"leader-1","connected":true,"reconnectDeadline":null},
             "participantCount":2,"result":\(result)}
            """
        let client = TraySignalingClient(joinUrl: url) { request in
            let response = try XCTUnwrap(
                HTTPURLResponse(
                    url: XCTUnwrap(request.url), statusCode: statusCode,
                    httpVersion: nil, headerFields: nil))
            return (Data(body.utf8), response)
        }
        return try await client.attach(controllerId: "ctrl-1")
    }

    func testAttachDecodesSupersededPlanWithItsReplacementJoinUrl() async throws {
        let plan = try await attachPlan(
            result: """
                {"action":"fail","code":"TRAY_SUPERSEDED","error":"moved",
                 "joinUrl":"https://tray.example/join/new.secret"}
                """)

        XCTAssertEqual(plan.action, .fail)
        XCTAssertEqual(plan.code, "TRAY_SUPERSEDED")
        XCTAssertEqual(plan.error, "moved")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://tray.example/join/new.secret")
    }

    func testAttachRejectsSupersededPlanWithoutAJoinUrl() async {
        // Mirrors `isFollowerAttachResponse` in tray-follower.ts: without the
        // replacement there is nothing to follow, so the reply is malformed
        // rather than a redirect we could act on.
        do {
            let plan = try await attachPlan(
                result: #"{"action":"fail","code":"TRAY_SUPERSEDED","error":"moved"}"#)
            XCTFail("Expected a malformed-response error, got \(plan.code)")
        } catch let error as TraySignalingError {
            guard case .invalidAttachResponse = error else {
                return XCTFail("Expected invalidAttachResponse, got \(error)")
            }
        } catch {
            XCTFail("Expected TraySignalingError, got \(error)")
        }
    }

    func testAttachRejectsSupersededPlanWithABlankJoinUrl() async {
        // Fail at the wire rather than leaning on the redirect policy to map a
        // blank replacement to a terminal outcome later.
        for blank in ["", "   ", "\\n"] {
            do {
                let plan = try await attachPlan(
                    result: """
                        {"action":"fail","code":"TRAY_SUPERSEDED","error":"moved",
                         "joinUrl":"\(blank)"}
                        """)
                XCTFail("Expected a malformed-response error, got \(plan.code)")
            } catch let error as TraySignalingError {
                guard case .invalidAttachResponse = error else {
                    return XCTFail("Expected invalidAttachResponse, got \(error)")
                }
            } catch {
                XCTFail("Expected TraySignalingError, got \(error)")
            }
        }
    }

    func testAttachStillRejectsAnUnknownFailCode() async {
        do {
            let plan = try await attachPlan(
                result: #"{"action":"fail","code":"WHAT_IS_THIS","error":"nope"}"#)
            XCTFail("Expected a malformed-response error, got \(plan.code)")
        } catch let error as TraySignalingError {
            guard case .invalidAttachResponse = error else {
                return XCTFail("Expected invalidAttachResponse, got \(error)")
            }
        } catch {
            XCTFail("Expected TraySignalingError, got \(error)")
        }
    }

    func testOtherFailCodesCarryNoReplacementUrl() async throws {
        let plan = try await attachPlan(
            statusCode: 410,
            result: """
                {"action":"fail","code":"TRAY_EXPIRED","error":"expired",
                 "joinUrl":"https://tray.example/join/should-be-ignored.secret"}
                """)

        // `joinUrl` is only meaningful for TRAY_SUPERSEDED; a stray one on any
        // other code must not turn a dead tray into a redirect.
        XCTAssertNil(plan.supersededByJoinUrl)
    }

    // MARK: - Redirect policy

    private func plan(code: String, joinUrl: String?) -> FollowerAttachPlan {
        FollowerAttachPlan(
            trayId: "tray-1", controllerId: "ctrl-1", participantCount: 1, leader: nil,
            action: .fail, code: code, retryAfterMs: nil, error: "moved", bootstrap: nil,
            iceServers: nil, supersededByJoinUrl: joinUrl)
    }

    func testFollowsASupersededTrayToItsReplacement() throws {
        let outcome = SupersedeRedirect.outcome(
            for: plan(code: "TRAY_SUPERSEDED", joinUrl: "https://tray.example/join/new.secret"),
            redirectsFollowed: 0)

        XCTAssertEqual(
            outcome, .follow(try XCTUnwrap(URL(string: "https://tray.example/join/new.secret"))))
        XCTAssertNil(SupersedeRedirect.failureMessage(for: outcome))
    }

    func testTerminalFailCodesAreNotRedirects() {
        for code in ["TRAY_EXPIRED", "INVALID_JOIN_CAPABILITY"] {
            XCTAssertEqual(
                SupersedeRedirect.outcome(
                    for: plan(code: code, joinUrl: nil), redirectsFollowed: 0),
                .terminal, code)
        }
    }

    func testABlankReplacementIsTerminalRatherThanARedirect() {
        for blank in ["", "   ", "\n"] {
            XCTAssertEqual(
                SupersedeRedirect.outcome(
                    for: plan(code: "TRAY_SUPERSEDED", joinUrl: blank), redirectsFollowed: 0),
                .terminal, "blank \(blank.debugDescription)")
        }
    }

    func testTheChainIsBoundedSoARedirectCycleCannotSpin() {
        let superseded = plan(
            code: "TRAY_SUPERSEDED", joinUrl: "https://tray.example/join/new.secret")

        XCTAssertEqual(SupersedeRedirect.maxRedirects, 5, "must match the browser and CLI bound")
        for followed in 0..<SupersedeRedirect.maxRedirects {
            guard
                case .follow = SupersedeRedirect.outcome(
                    for: superseded, redirectsFollowed: followed)
            else {
                return XCTFail("hop \(followed) must still be followed")
            }
        }

        let exhausted = SupersedeRedirect.outcome(
            for: superseded, redirectsFollowed: SupersedeRedirect.maxRedirects)
        XCTAssertEqual(exhausted, .exhausted)
        XCTAssertNotNil(SupersedeRedirect.failureMessage(for: exhausted))
    }

    func testARelativeOrSchemelessReplacementIsRejected() {
        // `URL(string:)` happily accepts these, and dialing one would produce
        // an unusable request rather than a clear failure.
        for bad in ["not-a-url", "/join/relative", "join/also-relative"] {
            XCTAssertEqual(
                SupersedeRedirect.outcome(
                    for: plan(code: "TRAY_SUPERSEDED", joinUrl: bad), redirectsFollowed: 0),
                .invalidJoinUrl, bad)
        }
    }

    func testFailureMessagesNeverLeakTheJoinUrl() {
        let secret = "https://tray.example/join/new.secret"
        for outcome in [SupersedeRedirect.Outcome.exhausted, .invalidJoinUrl] {
            let message = SupersedeRedirect.failureMessage(for: outcome) ?? ""
            XCTAssertFalse(message.isEmpty, "\(outcome) needs a user-facing reason")
            XCTAssertFalse(message.contains(secret), "\(outcome) must not carry the session secret")
            XCTAssertFalse(message.contains("join/"), "\(outcome) must not carry the session secret")
        }
    }
}
