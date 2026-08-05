import Foundation
import XCTest

@testable import SliccTrayKit

@MainActor
final class OpenApprovalTests: XCTestCase {
    private actor ManualSleeper {
        private var elapsed = false
        private var waiter: CheckedContinuation<Void, Never>?

        func sleep() async throws {
            if elapsed { return }
            await withCheckedContinuation { waiter = $0 }
            try Task.checkCancellation()
        }

        func elapse() {
            elapsed = true
            waiter?.resume()
            waiter = nil
        }
    }

    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_750_000_000)
    }

    private final class Wire {
        var sent: [FollowerToLeaderMessage] = []
        var succeeds = true

        func send(_ message: FollowerToLeaderMessage) -> Bool {
            sent.append(message)
            return succeeds
        }

        var responses: [(String, Int, String?, String?)] {
            sent.compactMap {
                guard case .execResponse(let id, let code, let signal, let error) = $0 else {
                    return nil
                }
                return (id, code, signal, error)
            }
        }

        var chunks: [(String, String, String)] {
            sent.compactMap {
                guard case .execChunk(let id, let stream, let data) = $0 else { return nil }
                return (id, stream, data)
            }
        }
    }

    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "OpenApprovalTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testParserAcceptsOnlyDocumentedGrammarAndOneQuoteLayer() throws {
        let plain = try OpenCommandParser.parse("open fixtureapp://calendar/create?item=1&mode=fast")
        XCTAssertEqual(plain.mode, .standard)
        XCTAssertEqual(plain.displayScheme, "fixtureapp")
        XCTAssertEqual(plain.displayHostAction, "calendar/create")
        XCTAssertFalse(plain.returnsResultData)

        let universal = try OpenCommandParser.parse(
            "open --universal 'https://example.com/calendar/create?item=1'")
        XCTAssertEqual(universal.mode, .universal)
        XCTAssertEqual(universal.scope.authority, "example.com")
        XCTAssertEqual(universal.scope.actionPrefix, "calendar")

        let callback = try OpenCommandParser.parse(
            "open --x-callback \"fixtureapp://calendar/create?item=1\"")
        XCTAssertEqual(callback.mode, .xCallback)
        XCTAssertTrue(callback.returnsResultData)
    }

    func testParserRejectsUnknownVerbUsageAndShellSyntax() {
        assertParseFailure("uname -a", code: .unsupportedVerb, contains: "open")
        assertParseFailure("Open fixtureapp://calendar/create", code: .unsupportedVerb)
        assertParseFailure("open", code: .usage)
        assertParseFailure("open --unknown fixtureapp://calendar/create", code: .usage)
        assertParseFailure(
            "open --universal --x-callback fixtureapp://calendar/create", code: .usage)
        assertParseFailure("open fixtureapp://calendar/create;uname", code: .usage)
        assertParseFailure("open fixtureapp://calendar/create|uname", code: .usage)
        assertParseFailure("open \"'fixtureapp://calendar/create'\"", code: .usage)
        assertParseFailure("open fixtureapp://calendar/create other", code: .usage)
        assertParseFailure("open --universal fixtureapp://calendar/create", code: .invalidURL)
        assertParseFailure("open file:///private/secret", code: .invalidURL)
    }

    func testGrantScopeOmitsQueryButDoesNotWidenAcrossDestinationIdentity() throws {
        let approved = try OpenCommandParser.parse(
            "open fixtureapp://calendar/create?private=one").scope
        XCTAssertEqual(
            approved,
            try OpenCommandParser.parse(
                "open fixtureapp://calendar/create?private=two").scope)
        XCTAssertNotEqual(
            approved,
            try OpenCommandParser.parse("open otherapp://calendar/create?private=one").scope)
        XCTAssertNotEqual(
            approved,
            try OpenCommandParser.parse("open fixtureapp://attacker/create?private=one").scope)
        XCTAssertNotEqual(
            approved,
            try OpenCommandParser.parse("open fixtureapp://calendar/delete?private=one").scope)
        XCTAssertNotEqual(
            approved,
            try OpenCommandParser.parse("open fixtureapp://calendar/%63reate?private=one").scope)
    }

    func testAllowOnceAndDenyEachSettleExactlyOnce() {
        let wire = Wire()
        let controller = makeController(wire: wire)

        controller.handle(
            requestId: "allow", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "allow", decision: .allowOnce)
        controller.resolve(requestId: "allow", decision: .deny)

        controller.handle(
            requestId: "deny", command: "open fixtureapp://calendar/delete",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "deny", decision: .deny)

        XCTAssertEqual(wire.responses.map(\.1), [0, OpenExecExitCode.denied.rawValue])
        XCTAssertTrue(controller.pendingApprovals.isEmpty)
        XCTAssertEqual(wire.chunks.count, 2)
        XCTAssertEqual(wire.chunks.first?.1, "stderr")
        XCTAssertEqual(
            Data(base64Encoded: wire.chunks.first?.2 ?? "").flatMap { String(data: $0, encoding: .utf8) },
            OpenApprovalController.waitingProgress)
    }

    func testAlwaysAllowPersistsPregrantAndRevocationReshowsCard() throws {
        let wire = Wire()
        let store = OpenGrantStore(defaults: defaults)
        let controller = makeController(wire: wire, grantStore: store)
        controller.handle(
            requestId: "first", command: "open fixtureapp://calendar/create?one=1",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "first", decision: .alwaysAllow)
        XCTAssertEqual(store.grants.count, 1)

        let reloaded = OpenGrantStore(defaults: defaults)
        let secondWire = Wire()
        let second = makeController(wire: secondWire, grantStore: reloaded)
        second.handle(
            requestId: "pregranted", command: "open fixtureapp://calendar/create?two=2",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        XCTAssertEqual(secondWire.responses.map(\.1), [0])
        XCTAssertTrue(second.pendingApprovals.isEmpty)
        XCTAssertTrue(secondWire.chunks.isEmpty)

        second.revokeGrant(id: try XCTUnwrap(reloaded.grants.first?.id))
        second.handle(
            requestId: "revoked", command: "open fixtureapp://calendar/create?three=3",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        XCTAssertEqual(second.pendingApprovals.map(\.requestId), ["revoked"])
        XCTAssertEqual(secondWire.chunks.count, 1)
    }

    func testTimeoutDisconnectAndSignalCancelWithDistinctFailures() async {
        let clock = Clock()
        let sleeper = ManualSleeper()
        let wire = Wire()
        let controller = makeController(wire: wire, clock: clock, sleeper: sleeper)

        controller.handle(
            requestId: "timeout", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        clock.now = clock.now.addingTimeInterval(2)
        await sleeper.elapse()
        for _ in 0..<20 where wire.responses.isEmpty { await Task.yield() }
        XCTAssertEqual(wire.responses.first?.1, OpenExecExitCode.timeout.rawValue)

        controller.handle(
            requestId: "signal", command: "open fixtureapp://calendar/delete",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.cancel(requestId: "signal", signal: "SIGINT")
        XCTAssertEqual(wire.responses.last?.1, OpenExecExitCode.cancelled.rawValue)
        XCTAssertEqual(wire.responses.last?.2, "SIGINT")

        controller.handle(
            requestId: "disconnect", command: "open fixtureapp://calendar/update",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.disconnect()
        XCTAssertEqual(wire.responses.last?.1, OpenExecExitCode.cancelled.rawValue)
        XCTAssertTrue(controller.pendingApprovals.isEmpty)
    }

    func testMalformedUnknownAndUnavailableEmitTerminalResponses() {
        let wire = Wire()
        let controller = makeController(wire: wire)
        controller.handle(
            requestId: "bad-url", command: "open not-a-url",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.handle(
            requestId: "unknown", command: "pwd",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        wire.succeeds = false
        controller.handle(
            requestId: "unavailable", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")

        XCTAssertEqual(
            wire.responses.map(\.1),
            [
                OpenExecExitCode.invalidURL.rawValue,
                OpenExecExitCode.unsupportedVerb.rawValue,
                OpenExecExitCode.unavailable.rawValue,
            ])
        XCTAssertTrue(wire.responses[1].3?.contains("open") == true)
    }

    private func makeController(
        wire: Wire,
        grantStore: OpenGrantStore? = nil,
        clock: Clock? = nil,
        sleeper: ManualSleeper? = nil
    ) -> OpenApprovalController {
        let clock = clock ?? Clock()
        return OpenApprovalController(
            grantStore: grantStore ?? OpenGrantStore(defaults: nil),
            timeout: 1,
            now: { clock.now },
            sleep: { nanoseconds in
                if let sleeper {
                    try await sleeper.sleep()
                } else {
                    try await Task.sleep(nanoseconds: nanoseconds)
                }
            },
            send: wire.send)
    }

    private func assertParseFailure(
        _ command: String,
        code: OpenExecExitCode,
        contains expectedText: String? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try OpenCommandParser.parse(command), file: file, line: line) { error in
            guard let parsed = error as? OpenCommandParseError else {
                return XCTFail("Unexpected error: \(error)", file: file, line: line)
            }
            XCTAssertEqual(parsed.exitCode, code, file: file, line: line)
            if let expectedText {
                XCTAssertTrue(parsed.message.contains(expectedText), file: file, line: line)
            }
        }
    }
}
