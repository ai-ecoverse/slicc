import Foundation
import XCTest

@testable import SliccTrayKit

@MainActor
final class OpenApprovalTests: XCTestCase {
    private struct DestinationCase {
        let url: String
        let expectedDestination: String
        let shouldAccept: Bool
    }

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
            guard succeeds else { return false }
            sent.append(message)
            return true
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
        assertParseFailure("open\tfixtureapp://calendar/create", code: .usage)
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

    func testParserRejectsCanonicalizationAndEncodedPathAmbiguity() {
        let rejectedURLs = [
            "https://example.com/../admin",
            "https://example.com/action/./admin",
            "https://example.com/action/../admin",
            "https://example.com/action/..",
            "https://example.com/action/%2e%2e/admin",
            "https://example.com/action/%2E%2e/admin",
            "https://example.com/action%2fadmin",
            "https://example.com/action%2Fadmin",
            "fixtureapp://calendar/action/../admin",
            "fixtureapp://calendar/action/%2e%2e/admin",
        ]

        for url in rejectedURLs {
            assertParseFailure("open \(url)", code: .invalidURL)
        }
    }

    func testGrantScopesMatchIndependentDestinationExpectations() {
        let cases = [
            DestinationCase(
                url: "https://example.com/action?private=one",
                expectedDestination: "https://example.com/action", shouldAccept: true),
            DestinationCase(
                url: "https://example.com/action/subpath?private=two",
                expectedDestination: "https://example.com/action", shouldAccept: true),
            DestinationCase(
                url: "https://example.com/admin",
                expectedDestination: "https://example.com/admin", shouldAccept: true),
            DestinationCase(
                url: "fixtureapp:calendar/create",
                expectedDestination: "fixtureapp:calendar", shouldAccept: true),
            DestinationCase(
                url: "fixtureapp:calendar/delete",
                expectedDestination: "fixtureapp:calendar", shouldAccept: true),
            DestinationCase(
                url: "fixtureapp:contacts/create",
                expectedDestination: "fixtureapp:contacts", shouldAccept: true),
            DestinationCase(
                url: "fixtureapp:calendar/create/../admin",
                expectedDestination: "fixtureapp:calendar/admin", shouldAccept: false),
            DestinationCase(
                url: "fixtureapp:calendar/%252e%252e/admin",
                expectedDestination: "fixtureapp:calendar/admin", shouldAccept: false),
            DestinationCase(
                url: "fixtureapp:calendar/%252E%252e/admin",
                expectedDestination: "fixtureapp:calendar/admin", shouldAccept: false),
            DestinationCase(
                url: "fixtureapp:calendar/create%252Fadmin",
                expectedDestination: "fixtureapp:calendar/create/admin", shouldAccept: false),
            DestinationCase(
                url: "fixtureapp:calendar/create%252fadmin",
                expectedDestination: "fixtureapp:calendar/create/admin", shouldAccept: false),
            DestinationCase(
                url: "fixtureapp:calendar/create%255Cadmin",
                expectedDestination: "fixtureapp:calendar/create/admin", shouldAccept: false),
            DestinationCase(
                url: "fixtureapp:calendar/a/b/../../c",
                expectedDestination: "fixtureapp:calendar/c", shouldAccept: false),
            DestinationCase(
                url: "fixtureapp:calendar/create/..",
                expectedDestination: "fixtureapp:calendar", shouldAccept: false),
            DestinationCase(
                url: "https://example.com/action/%252E%252e/admin",
                expectedDestination: "https://example.com/admin", shouldAccept: false),
        ]
        var parsedCases: [(DestinationCase, OpenGrantScope)] = []

        for testCase in cases {
            do {
                let parsed = try OpenCommandParser.parse("open \(testCase.url)")
                parsedCases.append((testCase, parsed.scope))
                XCTAssertTrue(
                    testCase.shouldAccept,
                    "unexpectedly accepted \(testCase.url) as \(testCase.expectedDestination)")
            } catch {
                XCTAssertFalse(
                    testCase.shouldAccept,
                    "unexpectedly rejected \(testCase.url) as \(testCase.expectedDestination)")
            }
        }

        for leftIndex in parsedCases.indices {
            for rightIndex in parsedCases.indices where leftIndex < rightIndex {
                let left = parsedCases[leftIndex]
                let right = parsedCases[rightIndex]
                if left.1 == right.1 {
                    XCTAssertEqual(
                        left.0.expectedDestination, right.0.expectedDestination,
                        "equal scopes disagree for \(left.0.url) and \(right.0.url)")
                }
                if left.0.expectedDestination != right.0.expectedDestination {
                    XCTAssertNotEqual(
                        left.1, right.1,
                        "different destinations collide for \(left.0.url) and \(right.0.url)")
                }
            }
        }
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

    func testExpiredAlwaysAllowSettlesTimeoutWithoutPersistingGrant() {
        let clock = Clock()
        let sleeper = ManualSleeper()
        let wire = Wire()
        let store = OpenGrantStore(defaults: defaults)
        let controller = makeController(
            wire: wire, grantStore: store, clock: clock, sleeper: sleeper)
        controller.handle(
            requestId: "expired", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")

        clock.now = clock.now.addingTimeInterval(2)
        controller.resolve(requestId: "expired", decision: .alwaysAllow)

        XCTAssertEqual(wire.responses.map(\.1), [OpenExecExitCode.timeout.rawValue])
        XCTAssertTrue(store.grants.isEmpty)
        XCTAssertTrue(controller.pendingApprovals.isEmpty)
    }

    func testSettledRequestReplayAfterDisconnectIsIgnored() {
        let wire = Wire()
        let controller = makeController(wire: wire)
        controller.handle(
            requestId: "replay", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "replay", decision: .allowOnce)
        controller.disconnect()
        controller.transportAvailable()
        let sentCount = wire.sent.count

        controller.handle(
            requestId: "replay", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")

        XCTAssertEqual(wire.sent.count, sentCount)
        XCTAssertTrue(controller.pendingApprovals.isEmpty)
    }

    func testFailedResponseIsRetainedAndRedeliveredWhenTransportReturns() {
        let wire = Wire()
        let controller = makeController(wire: wire)
        controller.handle(
            requestId: "retry", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        wire.succeeds = false
        controller.resolve(requestId: "retry", decision: .allowOnce)

        XCTAssertTrue(wire.responses.isEmpty)
        XCTAssertEqual(controller.pendingResponseCount, 1)

        wire.succeeds = true
        controller.transportAvailable()
        XCTAssertEqual(wire.responses.map(\.1), [OpenExecExitCode.success.rawValue])
        XCTAssertEqual(controller.pendingResponseCount, 0)
    }

    func testReplayAndResponseQueuesAreFIFOBounded() {
        let store = OpenRequestStore(tombstoneLimit: 2)
        XCTAssertTrue(store.claim(requestId: "one"))
        XCTAssertTrue(store.claim(requestId: "two"))
        XCTAssertTrue(store.claim(requestId: "three"))
        XCTAssertTrue(store.claim(requestId: "one"), "oldest tombstone should be evicted")

        let wire = Wire()
        wire.succeeds = false
        let controller = makeController(wire: wire, pendingResponseLimit: 2)
        for requestId in ["one", "two"] {
            controller.handle(
                requestId: requestId, command: "pwd",
                requesterIdentity: "Leader", sessionIdentity: "Session")
        }
        XCTAssertEqual(controller.pendingResponseCount, 2)

        wire.succeeds = true
        controller.handle(
            requestId: "three", command: "pwd",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        XCTAssertEqual(wire.responses.map(\.0), ["one", "two", "three"])
        XCTAssertEqual(controller.pendingResponseCount, 0)

        wire.succeeds = false
        for requestId in ["four", "five", "six"] {
            controller.handle(
                requestId: requestId, command: "pwd",
                requesterIdentity: "Leader", sessionIdentity: "Session")
        }
        XCTAssertEqual(controller.pendingResponseCount, 2)

        wire.succeeds = true
        controller.transportAvailable()
        XCTAssertEqual(wire.responses.map(\.0), ["one", "two", "three", "five", "six"])
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
            ])
        XCTAssertTrue(wire.responses[1].3?.contains("open") == true)
        XCTAssertEqual(controller.pendingResponseCount, 1)

        wire.succeeds = true
        controller.transportAvailable()
        XCTAssertEqual(wire.responses.last?.1, OpenExecExitCode.unavailable.rawValue)
    }

    private func makeController(
        wire: Wire,
        grantStore: OpenGrantStore? = nil,
        clock: Clock? = nil,
        sleeper: ManualSleeper? = nil,
        pendingResponseLimit: Int = OpenApprovalLimits.pendingResponses
    ) -> OpenApprovalController {
        let clock = clock ?? Clock()
        return OpenApprovalController(
            grantStore: grantStore ?? OpenGrantStore(defaults: nil),
            timeout: 1,
            pendingResponseLimit: pendingResponseLimit,
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
