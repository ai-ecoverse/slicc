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

    private final class Launcher {
        var requests: [OpenLaunchRequest] = []

        func launch(_ request: OpenLaunchRequest) {
            requests.append(request)
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
            "open --x-success slicc://host fixtureapp://calendar/create", code: .usage)
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
        let approved = try OpenCommandParser.parse("open fixtureapp://calendar/create?private=one").scope
        XCTAssertEqual(
            approved,
            try OpenCommandParser.parse("open fixtureapp://calendar/create?private=two").scope)
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
        let launcher = Launcher()
        let controller = makeController(wire: wire, launcher: launcher)

        controller.handle(
            requestId: "allow", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "allow", decision: .allowOnce)
        XCTAssertEqual(launcher.requests.map(\.requestId), ["allow"])
        controller.completeLaunch(requestId: "allow", opened: true)
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
        let launcher = Launcher()
        let store = OpenGrantStore(defaults: defaults)
        let controller = makeController(wire: wire, grantStore: store, launcher: launcher)
        controller.handle(
            requestId: "first", command: "open fixtureapp://calendar/create?one=1",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "first", decision: .alwaysAllow)
        XCTAssertTrue(store.grants.isEmpty, "a failed launch must not persist a grant")
        controller.completeLaunch(requestId: "first", opened: true)
        XCTAssertEqual(store.grants.count, 1)

        let reloaded = OpenGrantStore(defaults: defaults)
        let secondWire = Wire()
        let secondLauncher = Launcher()
        let second = makeController(
            wire: secondWire, grantStore: reloaded, launcher: secondLauncher)
        second.handle(
            requestId: "pregranted", command: "open fixtureapp://calendar/create?two=2",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        XCTAssertEqual(secondLauncher.requests.map(\.requestId), ["pregranted"])
        second.completeLaunch(requestId: "pregranted", opened: true)
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
        let launcher = Launcher()
        let controller = makeController(wire: wire, launcher: launcher)
        controller.handle(
            requestId: "replay", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "replay", decision: .allowOnce)
        controller.completeLaunch(requestId: "replay", opened: true)
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
        let launcher = Launcher()
        let controller = makeController(wire: wire, launcher: launcher)
        controller.handle(
            requestId: "retry", command: "open fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        wire.succeeds = false
        controller.resolve(requestId: "retry", decision: .allowOnce)
        controller.completeLaunch(requestId: "retry", opened: true)

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

    func testTombstoneEvictionNeverExposesALiveRequestToReplay() throws {
        let store = OpenRequestStore(tombstoneLimit: 1)
        XCTAssertTrue(store.claim(requestId: "live"))
        let command = try OpenCommandParser.parse("open fixtureapp://calendar/create")
        store.insertClaimed(
            OpenApprovalRequest(
                requestId: "live", command: command,
                requesterIdentity: "Leader", sessionIdentity: "Session"),
            expiresAt: Date(timeIntervalSince1970: 1_750_000_000))

        for requestId in ["filler-one", "filler-two", "filler-three"] {
            XCTAssertTrue(store.claim(requestId: requestId))
        }
        XCTAssertFalse(store.claim(requestId: "live"), "a pending request must stay unreplayable")
        XCTAssertNotNil(store.request(id: "live"))

        XCTAssertNotNil(store.settle(id: "live"))
        XCTAssertFalse(store.claim(requestId: "live"), "a settled request stays tombstoned")
        XCTAssertTrue(store.claim(requestId: "filler-four"))
        XCTAssertTrue(store.claim(requestId: "live"), "settled tombstones are evictable")
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
}

extension OpenApprovalTests {
    func testApprovedLaunchUsesExplicitModeAndCompletionAvailability() {
        let wire = Wire()
        let launcher = Launcher()
        let controller = makeController(wire: wire, launcher: launcher)
        let cases = [
            ("standard", "open fixtureapp://calendar/create", OpenCommandMode.standard),
            ("universal", "open --universal https://example.com/action", .universal),
            ("callback", "open --x-callback fixtureapp://calendar/create", .xCallback),
        ]

        for (requestId, command, mode) in cases {
            controller.handle(
                requestId: requestId, command: command,
                requesterIdentity: "Leader", sessionIdentity: "Session")
            controller.resolve(requestId: requestId, decision: .allowOnce)
            XCTAssertEqual(launcher.requests.last?.mode, mode)
            if mode != .xCallback {
                XCTAssertEqual(
                    launcher.requests.last?.url.absoluteString,
                    command.split(separator: " ").last.map(String.init))
            }
            controller.completeLaunch(requestId: requestId, opened: false)
        }

        XCTAssertEqual(
            wire.responses.map(\.1),
            Array(repeating: OpenExecExitCode.unavailable.rawValue, count: cases.count))
    }

    func testXCallbackConstructionReplacesEncodedLeaderDestinationsWithoutChangingPayload() throws {
        let command = try OpenCommandParser.parse(
            "open --x-callback fixtureapp://calendar/create?keep=%252F&%2578-success=evil&x-error=bad#frag")
        let url = try OpenCallbackCodec.launchURL(
            for: command, requestId: "request one", nonce: "nonce")
        let absolute = url.absoluteString

        XCTAssertTrue(absolute.contains("keep=%252F"))
        XCTAssertTrue(absolute.hasSuffix("#frag"))
        XCTAssertFalse(absolute.contains("evil"))
        XCTAssertFalse(absolute.contains("x-error=bad"))
        XCTAssertEqual(absolute.components(separatedBy: "x-success=").count - 1, 1)
        XCTAssertEqual(absolute.components(separatedBy: "x-error=").count - 1, 1)
        XCTAssertEqual(absolute.components(separatedBy: "x-cancel=").count - 1, 1)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        for key in ["x-success", "x-error", "x-cancel"] {
            let value = try XCTUnwrap(components.queryItems?.first { $0.name == key }?.value)
            let callback = try XCTUnwrap(URL(string: value))
            XCTAssertEqual(callback.scheme, OpenCallbackCodec.scheme)
            XCTAssertTrue(callback.absoluteString.contains("requestId=request%20one"))
            XCTAssertTrue(callback.absoluteString.contains("nonce=nonce"))
        }
    }

    func testCallbackDecoderUsesFixedPointPercentDecodingAndNonceIsCryptographicWidth() throws {
        let callback = try XCTUnwrap(
            URL(
                string:
                    "slicc-open-callback://x-callback/success?requestId=%2572equest&nonce=%256Eonce&item=%25252F"))
        let outcome = OpenCallbackCodec.decode(callback)
        guard case .result(let requestId, let nonce, let result, _) = outcome else {
            return XCTFail("fixed-point callback should decode")
        }
        XCTAssertEqual(requestId, "request")
        XCTAssertEqual(nonce, "nonce")
        XCTAssertEqual(result.parameters, [OpenCallbackParameter(name: "item", value: "/")])

        let generated = try OpenCallbackCodec.makeNonce()
        XCTAssertEqual(generated.count, 43)
        XCTAssertNotNil(
            Data(
                base64Encoded: generated.replacingOccurrences(of: "-", with: "+")
                    .replacingOccurrences(of: "_", with: "/") + "="))
    }

    func testXCallbackStatusesSettleOnceAndSerializeOrderedDuplicateParameters() throws {
        let cases: [(OpenCallbackStatus, OpenExecExitCode)] = [
            (.success, .success), (.error, .callbackError), (.cancel, .cancelled),
        ]

        for (status, expectedCode) in cases {
            let wire = Wire()
            let launcher = Launcher()
            let controller = makeController(wire: wire, launcher: launcher)
            controller.handle(
                requestId: status.rawValue,
                command: "open --x-callback fixtureapp://calendar/create",
                requesterIdentity: "Leader", sessionIdentity: "Session")
            controller.resolve(requestId: status.rawValue, decision: .allowOnce)
            controller.completeLaunch(requestId: status.rawValue, opened: true)
            let callback = try makeCallbackURL(
                status: status, requestId: status.rawValue, nonce: "fixed-nonce",
                parameters: [("item", "one"), ("item", "two")])

            XCTAssertTrue(controller.handleCallbackURL(callback))
            XCTAssertTrue(controller.handleCallbackURL(callback), "replay is consumed silently")
            XCTAssertEqual(wire.responses.map(\.1), [expectedCode.rawValue])
            let result = try XCTUnwrap(stdoutResults(wire).first)
            XCTAssertEqual(result.status, status)
            XCTAssertEqual(result.parameters.map(\.value), ["one", "two"])
        }
    }

    func testUnknownWrongNonceAndRestoredProcessCallbacksEmitNothing() throws {
        let wire = Wire()
        let controller = makeController(wire: wire)
        controller.handle(
            requestId: "live", command: "open --x-callback fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "live", decision: .allowOnce)
        controller.completeLaunch(requestId: "live", opened: true)

        let hostile = [
            try makeCallbackURL(status: .success, requestId: "unknown", nonce: "fixed-nonce"),
            try makeCallbackURL(status: .success, requestId: "live", nonce: "wrong"),
        ]
        for callback in hostile { XCTAssertTrue(controller.handleCallbackURL(callback)) }

        let restoredWire = Wire()
        let restored = makeController(wire: restoredWire)
        let validForOldProcess = try makeCallbackURL(
            status: .success, requestId: "live", nonce: "fixed-nonce")
        XCTAssertTrue(restored.handleCallbackURL(validForOldProcess))
        XCTAssertTrue(wire.responses.isEmpty)
        XCTAssertTrue(restoredWire.sent.isEmpty)
    }

    func testSignalDuringExternalAppWaitCancelsAndInvalidatesCallback() throws {
        let wire = Wire()
        let controller = makeController(wire: wire)
        controller.handle(
            requestId: "cancel-live", command: "open --x-callback fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "cancel-live", decision: .allowOnce)
        controller.completeLaunch(requestId: "cancel-live", opened: true)
        controller.cancel(requestId: "cancel-live", signal: "SIGINT")
        let callback = try makeCallbackURL(
            status: .success, requestId: "cancel-live", nonce: "fixed-nonce")

        XCTAssertTrue(controller.handleCallbackURL(callback))
        XCTAssertEqual(wire.responses.map(\.1), [OpenExecExitCode.cancelled.rawValue])
        XCTAssertTrue(stdoutResults(wire).isEmpty)
    }

    func testExpiredValidCallbackSettlesTimeoutAndReplayEmitsNothing() throws {
        let clock = Clock()
        let wire = Wire()
        let controller = makeController(wire: wire, clock: clock)
        controller.handle(
            requestId: "expired", command: "open --x-callback fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "expired", decision: .allowOnce)
        controller.completeLaunch(requestId: "expired", opened: true)
        clock.now = clock.now.addingTimeInterval(2)
        let callback = try makeCallbackURL(
            status: .success, requestId: "expired", nonce: "fixed-nonce")

        XCTAssertTrue(controller.handleCallbackURL(callback))
        XCTAssertTrue(controller.handleCallbackURL(callback))
        XCTAssertEqual(wire.responses.map(\.1), [OpenExecExitCode.timeout.rawValue])
        XCTAssertTrue(stdoutResults(wire).isEmpty)
    }

    func testCallbackCountAndSerializedByteBoundsAreExact() throws {
        let sixteen = (0..<OpenCallbackLimits.parameterCount).map { ("p\($0)", "v") }
        let acceptedCount = OpenCallbackCodec.decode(
            try makeCallbackURL(
                status: .success, requestId: "count", nonce: "n", parameters: sixteen))
        guard case .result = acceptedCount else { return XCTFail("limit should be accepted") }

        let rejectedCount = OpenCallbackCodec.decode(
            try makeCallbackURL(
                status: .success, requestId: "count", nonce: "n",
                parameters: sixteen + [("overflow", "v")]))
        XCTAssertEqual(rejectedCount, .overflow(requestId: "count", nonce: "n"))

        let empty = OpenCallbackResult(
            status: .success, parameters: [OpenCallbackParameter(name: "payload", value: "")])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let overhead = try encoder.encode(empty).count
        let exactValue = String(repeating: "a", count: OpenCallbackLimits.serializedBytes - overhead)
        let exact = OpenCallbackCodec.decode(
            try makeCallbackURL(
                status: .success, requestId: "bytes", nonce: "n",
                parameters: [("payload", exactValue)]))
        guard case .result(_, _, _, let json) = exact else {
            return XCTFail("exact byte limit should be accepted")
        }
        XCTAssertEqual(json.count, OpenCallbackLimits.serializedBytes)

        let overflow = OpenCallbackCodec.decode(
            try makeCallbackURL(
                status: .success, requestId: "bytes", nonce: "n",
                parameters: [("payload", exactValue + "a")]))
        XCTAssertEqual(overflow, .overflow(requestId: "bytes", nonce: "n"))
    }

    func testOversizeCallbackEmitsNonzeroResponseWithoutTruncation() throws {
        let wire = Wire()
        let controller = makeController(wire: wire)
        controller.handle(
            requestId: "oversize", command: "open --x-callback fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "oversize", decision: .allowOnce)
        controller.completeLaunch(requestId: "oversize", opened: true)
        let callback = try makeCallbackURL(
            status: .success, requestId: "oversize", nonce: "fixed-nonce",
            parameters: [("payload", String(repeating: "x", count: 17 * 1024))])

        XCTAssertTrue(controller.handleCallbackURL(callback))
        XCTAssertEqual(wire.responses.map(\.1), [OpenExecExitCode.callbackError.rawValue])
        XCTAssertTrue(stdoutResults(wire).isEmpty)
    }

    func testCallbackTerminalDeliveryRetriesChunkBeforeResponse() throws {
        let wire = Wire()
        let controller = makeController(wire: wire)
        controller.handle(
            requestId: "retry-callback",
            command: "open --x-callback fixtureapp://calendar/create",
            requesterIdentity: "Leader", sessionIdentity: "Session")
        controller.resolve(requestId: "retry-callback", decision: .allowOnce)
        controller.completeLaunch(requestId: "retry-callback", opened: true)
        wire.succeeds = false
        let callback = try makeCallbackURL(
            status: .success, requestId: "retry-callback", nonce: "fixed-nonce")

        XCTAssertTrue(controller.handleCallbackURL(callback))
        XCTAssertEqual(controller.pendingResponseCount, 1)
        XCTAssertTrue(wire.responses.isEmpty)
        wire.succeeds = true
        controller.transportAvailable()

        XCTAssertEqual(wire.sent.suffix(2).count, 2)
        guard case .execChunk(_, let stream, _) = wire.sent[wire.sent.count - 2] else {
            return XCTFail("stdout must precede settlement")
        }
        XCTAssertEqual(stream, "stdout")
        guard case .execResponse = wire.sent.last else {
            return XCTFail("response must follow stdout")
        }
    }

    private func makeController(
        wire: Wire,
        grantStore: OpenGrantStore? = nil,
        clock: Clock? = nil,
        sleeper: ManualSleeper? = nil,
        launcher: Launcher? = nil,
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
            send: wire.send,
            launch: (launcher ?? Launcher()).launch,
            makeNonce: { "fixed-nonce" })
    }

    private func makeCallbackURL(
        status: OpenCallbackStatus,
        requestId: String,
        nonce: String,
        parameters: [(String, String)] = []
    ) throws -> URL {
        var components = URLComponents()
        components.scheme = OpenCallbackCodec.scheme
        components.host = "x-callback"
        components.path = "/\(status.rawValue)"
        components.queryItems =
            [
                URLQueryItem(name: "requestId", value: requestId),
                URLQueryItem(name: "nonce", value: nonce),
            ] + parameters.map { URLQueryItem(name: $0.0, value: $0.1) }
        return try XCTUnwrap(components.url)
    }

    private func stdoutResults(_ wire: Wire) -> [OpenCallbackResult] {
        wire.chunks.compactMap { _, stream, base64 in
            guard stream == "stdout", let data = Data(base64Encoded: base64) else { return nil }
            return try? JSONDecoder().decode(OpenCallbackResult.self, from: data)
        }
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
