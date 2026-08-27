import Foundation
import SliccTraySession
import XCTest

@MainActor
final class SessionReachabilityTests: XCTestCase {
    func testDefaultInitializerPresumesUnprobedSessionReachable() {
        let reachability = SessionReachability()

        XCTAssertTrue(reachability.presumedReachable("unprobed-id"))
    }

    func testPresumesReachableBeforeVerdictLands() {
        let reachability = makeReachability { request in
            self.response(to: request, status: 200, json: #"{"leader":{"connected":true}}"#)
        }

        XCTAssertTrue(reachability.presumedReachable("unprobed-id"))
    }

    func testImmediateConnectedLeaderIsReachable() async {
        let reachability = makeReachability { request in
            self.response(to: request, status: 200, json: #"{"leader":{"connected":true}}"#)
        }
        let tray = makeSession(path: "initial")

        reachability.probe([tray])
        await waitForVerdict(tray.id, in: reachability)

        XCTAssertEqual(reachability.verdicts[tray.id], .reachable)
    }

    func testFollowsSupersededChainAndAddsJSONQueryToEveryHop() async {
        let transport = RecordingTransport { request, index in
            switch index {
            case 0:
                return self.response(
                    to: request,
                    status: 409,
                    json: #"{"code":"TRAY_SUPERSEDED","joinUrl":"https://example.invalid/next"}"#)
            case 1:
                return self.response(
                    to: request,
                    status: 409,
                    json: #"{"code":"TRAY_SUPERSEDED","joinUrl":"https://example.invalid/final"}"#)
            default:
                return self.response(
                    to: request, status: 200, json: #"{"leader":{"connected":true}}"#)
            }
        }
        let reachability = SessionReachability(
            maxSupersedeRedirects: 5, transport: transport.call)
        let tray = makeSession(path: "original")

        reachability.probe([tray])
        await waitForVerdict(tray.id, in: reachability)

        XCTAssertEqual(reachability.verdicts, [tray.id: .reachable])
        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 3)
        XCTAssertTrue(requests.allSatisfy { $0.cachePolicy == .reloadIgnoringLocalCacheData })
        XCTAssertTrue(
            requests.allSatisfy { request in
                URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                    .queryItems?.contains(URLQueryItem(name: "json", value: "true")) == true
            })
    }

    func testSupersededChainPastLimitIsUnreachable() async {
        let transport = RecordingTransport { request, _ in
            self.response(
                to: request,
                status: 409,
                json: #"{"code":"TRAY_SUPERSEDED","joinUrl":"https://example.invalid/next"}"#)
        }
        let reachability = SessionReachability(
            maxSupersedeRedirects: 2, transport: transport.call)
        let tray = makeSession(path: "limited")

        reachability.probe([tray])
        await waitForVerdict(tray.id, in: reachability)

        XCTAssertEqual(reachability.verdicts[tray.id], .unreachable)
        let requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 3)
    }

    func testExpiredAndOtherResponsesAreUnreachable() async {
        let cases: [(Int, String)] = [
            (409, #"{"code":"TRAY_EXPIRED"}"#),
            (409, #"{"code":"OTHER"}"#),
            (500, #"{"code":"SERVER_ERROR"}"#),
        ]

        for (index, item) in cases.enumerated() {
            let reachability = makeReachability { request in
                self.response(to: request, status: item.0, json: item.1)
            }
            let tray = makeSession(path: "failure-\(index)")
            reachability.probe([tray])
            await waitForVerdict(tray.id, in: reachability)
            XCTAssertEqual(reachability.verdicts[tray.id], .unreachable)
        }
    }

    func testMissingOrDisconnectedLeaderIsUnreachable() async {
        let bodies = [#"{}"#, #"{"leader":null}"#, #"{"leader":{"connected":false}}"#]

        for (index, body) in bodies.enumerated() {
            let reachability = makeReachability { request in
                self.response(to: request, status: 200, json: body)
            }
            let tray = makeSession(path: "leader-\(index)")
            reachability.probe([tray])
            await waitForVerdict(tray.id, in: reachability)
            XCTAssertEqual(reachability.verdicts[tray.id], .unreachable)
        }
    }

    func testTransportErrorsAndTimeoutsAreUnreachable() async {
        for (index, code) in [URLError.notConnectedToInternet, .timedOut].enumerated() {
            let reachability = makeReachability { _ in throw URLError(code) }
            let tray = makeSession(path: "transport-\(index)")
            reachability.probe([tray])
            await waitForVerdict(tray.id, in: reachability)
            XCTAssertEqual(reachability.verdicts[tray.id], .unreachable)
        }
    }

    func testUnparseableBodyIsUnreachable() async {
        let reachability = makeReachability { request in
            self.response(to: request, status: 200, json: "not-json")
        }
        let tray = makeSession(path: "invalid-body")

        reachability.probe([tray])
        await waitForVerdict(tray.id, in: reachability)

        XCTAssertEqual(reachability.verdicts[tray.id], .unreachable)
    }

    func testProbeDeduplicatesAnInFlightSession() async {
        let gate = AsyncGate()
        let transport = RecordingTransport { request, _ in
            await gate.wait()
            return self.response(
                to: request, status: 200, json: #"{"leader":{"connected":true}}"#)
        }
        let reachability = SessionReachability(
            maxSupersedeRedirects: 5, transport: transport.call)
        let tray = makeSession(path: "deduplicated")

        reachability.probe([tray])
        await waitForRequest(in: transport)
        reachability.probe([tray])
        let countWhileBlocked = await transport.requestCount()
        XCTAssertEqual(countWhileBlocked, 1)

        await gate.open()
        await waitForVerdict(tray.id, in: reachability)
        let finalCount = await transport.requestCount()
        XCTAssertEqual(finalCount, 1)
    }

    /// #1957: the probe hops on the `successor-version` link alone. The body
    /// here says nothing this build recognizes — and on the second hop is not
    /// even JSON — which is the shape that dead-ended the follower in #1956.
    func testFollowsSupersededChainFromTheLinkHeaderAlone() async {
        let transport = RecordingTransport { request, index in
            switch index {
            case 0:
                return self.response(
                    to: request, status: 409, json: #"{"action":"redirect"}"#,
                    headers: [
                        "Link":
                            #"<https://example.invalid/next>; rel="successor-version", "#
                            + #"<https://example.invalid/status>; rel="status""#
                    ])
            case 1:
                return self.response(
                    to: request, status: 409, json: "<html>gateway error</html>",
                    headers: ["Link": #"<https://example.invalid/final>; rel="successor-version""#])
            default:
                return self.response(
                    to: request, status: 200, json: #"{"leader":{"connected":true}}"#)
            }
        }
        let reachability = SessionReachability(
            maxSupersedeRedirects: 5, transport: transport.call)
        let tray = makeSession(path: "original")

        reachability.probe([tray])
        await waitForVerdict(tray.id, in: reachability)

        XCTAssertEqual(reachability.verdicts, [tray.id: .reachable])
        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests[1].url?.path, "/next")
        XCTAssertEqual(requests[2].url?.path, "/final")
        // Every hop still asks for JSON — a bare GET hits the SPA fallback.
        for request in requests {
            XCTAssertEqual(request.url?.query?.contains("json=true"), true)
        }
    }

    /// The link outranks a stale `joinUrl` still sitting in the body.
    func testLinkHeaderWinsOverTheBodyJoinUrl() async {
        let transport = RecordingTransport { request, index in
            index == 0
                ? self.response(
                    to: request, status: 409,
                    json: #"{"code":"TRAY_SUPERSEDED","joinUrl":"https://example.invalid/body"}"#,
                    headers: ["Link": #"<https://example.invalid/link>; rel="successor-version""#])
                : self.response(to: request, status: 200, json: #"{"leader":{"connected":true}}"#)
        }
        let reachability = SessionReachability(
            maxSupersedeRedirects: 5, transport: transport.call)
        let tray = makeSession(path: "original")

        reachability.probe([tray])
        await waitForVerdict(tray.id, in: reachability)

        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[1].url?.path, "/link")
    }

    /// A `successor-version` link is still bounded by the hop cap — the
    /// platform's redirect policy never gets a say.
    func testLinkHeaderChaseIsBounded() async {
        let transport = RecordingTransport { request, _ in
            self.response(
                to: request, status: 409, json: "{}",
                headers: ["Link": #"<https://example.invalid/loop>; rel="successor-version""#])
        }
        let reachability = SessionReachability(
            maxSupersedeRedirects: 2, transport: transport.call)
        let tray = makeSession(path: "original")

        reachability.probe([tray])
        await waitForVerdict(tray.id, in: reachability)

        XCTAssertEqual(reachability.verdicts[tray.id], .unreachable)
        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 3)  // initial + 2 hops, then the cap
    }

    private func makeReachability(
        transport: @escaping SessionReachability.Transport
    ) -> SessionReachability {
        SessionReachability(maxSupersedeRedirects: 5, transport: transport)
    }

    private func makeSession(path: String) -> SyncedTraySession {
        SyncedTraySession(
            joinUrl: "https://example.invalid/\(path)",
            label: "Test",
            deviceId: "device",
            deviceName: "Device",
            createdAt: .distantPast,
            lastSeenAt: .distantPast)
    }

    private func response(
        to request: URLRequest, status: Int, json: String,
        headers: [String: String]? = nil
    ) -> (Data, URLResponse) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
        return (Data(json.utf8), response)
    }

    private func waitForVerdict(
        _ id: String, in reachability: SessionReachability
    ) async {
        for _ in 0..<100 where reachability.verdicts[id] == nil {
            await Task.yield()
        }
        XCTAssertNotNil(reachability.verdicts[id])
    }

    private func waitForRequest(in transport: RecordingTransport) async {
        for _ in 0..<100 where await transport.requestCount() == 0 {
            await Task.yield()
        }
        let requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 1)
    }
}

private actor RecordingTransport {
    typealias Handler = (URLRequest, Int) async throws -> (Data, URLResponse)

    private var recordedRequests: [URLRequest] = []
    private let handler: Handler

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func call(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let index = recordedRequests.count
        recordedRequests.append(request)
        return try await handler(request, index)
    }

    func requests() -> [URLRequest] { recordedRequests }
    func requestCount() -> Int { recordedRequests.count }
}

private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }
}
