import Foundation
import XCTest

@testable import SliccTrayFollower

/// The transient-fault retry around every hub POST (#4120), over the
/// `Transport` seam with a fake clock — nothing here sleeps for real.
final class TraySignalingRetryTests: XCTestCase {

    private let joinUrl = URL(string: "https://www.sliccy.ai/join/tray.secret")!

    private struct Reply {
        var status: Int
        var body: String
        var headers: [String: String] = [:]
    }

    private enum Step {
        case reply(Reply)
        case fail(Error)
        /// A hub that holds the request open: answers only after `seconds` of
        /// real time, unless the attempt is cancelled first.
        case stall(seconds: TimeInterval, then: Reply)
    }

    /// Plays `steps` in order and advances a fake clock on every sleep.
    private final class FakeHub: @unchecked Sendable {
        private let lock = NSLock()
        private var steps: [Step]
        private(set) var requests = 0
        private(set) var sleeps: [TimeInterval] = []
        /// When each request started, against the fake clock, and the
        /// `timeoutInterval` it was sent with.
        private(set) var attempts: [(start: TimeInterval, timeout: TimeInterval)] = []
        private var elapsed: TimeInterval = 0
        private let start = Date(timeIntervalSince1970: 1_800_000_000)

        init(_ steps: [Step]) { self.steps = steps }

        var now: Date { lock.withLock { start.addingTimeInterval(elapsed) } }
        var elapsedSeconds: TimeInterval { lock.withLock { elapsed } }

        func sleep(_ seconds: TimeInterval) {
            lock.withLock {
                sleeps.append(seconds)
                elapsed += seconds
            }
        }

        func next(_ request: URLRequest, url: URL) async throws -> (Data, URLResponse) {
            let step: Step = lock.withLock {
                requests += 1
                attempts.append((elapsed, request.timeoutInterval))
                return steps.count > 1 ? steps.removeFirst() : steps[0]
            }
            let reply: Reply
            switch step {
            case .fail(let error):
                throw error
            case .stall(let seconds, let then):
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                reply = then
            case .reply(let answer):
                reply = answer
            }
            let response = HTTPURLResponse(
                url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
                headerFields: reply.headers)!
            return (Data(reply.body.utf8), response)
        }
    }

    /// `attemptTimer` defaults to one that never fires inside a test; the stall
    /// test swaps in one that spends the fake clock and fires at once.
    private func client(
        _ hub: FakeHub,
        attemptTimer: @escaping @Sendable (TimeInterval) async throws -> Void = { _ in
            try await Task.sleep(nanoseconds: 60_000_000_000)
        }
    ) -> TraySignalingClient {
        var retry = TraySignalingRetry()
        retry.now = { hub.now }
        retry.sleep = { hub.sleep($0) }
        retry.attemptTimer = attemptTimer
        retry.jitter = { $0 }
        return TraySignalingClient(joinUrl: joinUrl, retry: retry) { [joinUrl] request in
            try await hub.next(request, url: request.url ?? joinUrl)
        }
    }

    /// Every request must be able to finish by the deadline it was admitted under.
    private func assertAttemptsFitTheBudget(
        _ hub: FakeHub, file: StaticString = #filePath, line: UInt = #line
    ) {
        for attempt in hub.attempts {
            XCTAssertGreaterThan(attempt.timeout, 0, file: file, line: line)
            XCTAssertLessThanOrEqual(
                attempt.start + attempt.timeout, 8 + 1e-9,
                "attempt at \(attempt.start)s may run to \(attempt.start + attempt.timeout)s",
                file: file, line: line)
        }
    }

    private let signalBody = #"""
        {"trayId":"t1","controllerId":"c1","role":"follower",
         "leader":{"controllerId":"l1","connected":true,"reconnectDeadline":null},
         "participantCount":2,
         "result":{"action":"signal","code":"LEADER_CONNECTED",
                   "bootstrap":{"controllerId":"c1","bootstrapId":"b1","attempt":1,
                                "state":"pending","expiresAt":"2026-10-24T00:00:00Z",
                                "maxRetries":2,"retriesRemaining":2,
                                "cursor":0,"failure":null}}}
        """#

    private let unavailableBody = #"""
        {"error":"Tray temporarily unavailable","code":"TRAY_TEMPORARILY_UNAVAILABLE","retryable":true}
        """#

    private var signal: Step { .reply(Reply(status: 200, body: signalBody)) }
    private var unavailable: Step {
        .reply(Reply(status: 503, body: unavailableBody, headers: ["Retry-After": "1"]))
    }

    func testA503ThenSuccessAttaches() async throws {
        let hub = FakeHub([unavailable, signal])
        let plan = try await client(hub).attach(controllerId: "c1")
        XCTAssertEqual(plan.action, .signal)
        XCTAssertEqual(hub.requests, 2)
        XCTAssertEqual(hub.sleeps, [1])
    }

    func testACloudflare1101PageThenSuccessAttaches() async throws {
        let page = Reply(
            status: 500, body: "error code: 1101", headers: ["Content-Type": "text/plain"])
        let hub = FakeHub([.reply(page), signal])
        let plan = try await client(hub).attach(controllerId: "c1")
        XCTAssertEqual(plan.action, .signal)
        XCTAssertEqual(hub.requests, 2)
    }

    /// An edge page in place of JSON is transient even when the status says OK.
    func testANonJSONSuccessBodyThenSuccessAttaches() async throws {
        let hub = FakeHub([.reply(Reply(status: 200, body: "<html>bad gateway</html>")), signal])
        let plan = try await client(hub).attach(controllerId: "c1")
        XCTAssertEqual(plan.action, .signal)
        XCTAssertEqual(hub.requests, 2)
    }

    func testANetworkErrorThenSuccessAttaches() async throws {
        let hub = FakeHub([.fail(URLError(.networkConnectionLost)), signal])
        let plan = try await client(hub).attach(controllerId: "c1")
        XCTAssertEqual(plan.action, .signal)
        XCTAssertEqual(hub.requests, 2)
        XCTAssertEqual(hub.sleeps, [1])
    }

    func testRepeated503sGiveUpWithinTheBudgetWithAClearError() async {
        let hub = FakeHub([.reply(Reply(status: 503, body: unavailableBody))])
        do {
            let plan = try await client(hub).attach(controllerId: "c1")
            XCTFail("expected the retry to give up, got \(plan.code)")
        } catch let error as TraySignalingError {
            guard case .retriesExhausted(let attempts, .invalidResponse(503, _)) = error else {
                return XCTFail("unexpected \(error)")
            }
            XCTAssertEqual(attempts, hub.requests)
            let message = error.errorDescription ?? ""
            XCTAssertTrue(message.contains("unavailable after"), message)
            XCTAssertTrue(message.contains("TRAY_TEMPORARILY_UNAVAILABLE"), message)
        } catch {
            XCTFail("unexpected \(error)")
        }
        // Four attempts, 1 s + 2 s + 4 s apart, all inside the 8 s budget.
        XCTAssertEqual(hub.sleeps, [1, 2, 4])
        XCTAssertEqual(hub.requests, 4)
        XCTAssertLessThanOrEqual(hub.sleeps.reduce(0, +), 8)
        assertAttemptsFitTheBudget(hub)
    }

    /// A `Retry-After` that leaves half a second gives the last attempt half a
    /// second, not a one-second floor that runs past the budget.
    func testTheLastAttemptsTimeoutIsCappedAtTheTimeLeft() async throws {
        let limited = Reply(
            status: 503, body: unavailableBody, headers: ["Retry-After": "7.5"])
        let hub = FakeHub([.reply(limited), signal])
        let plan = try await client(hub).attach(controllerId: "c1")
        XCTAssertEqual(plan.action, .signal)
        XCTAssertEqual(hub.sleeps, [7.5])
        XCTAssertEqual(hub.attempts.last?.timeout ?? 0, 0.5, accuracy: 1e-9)
        assertAttemptsFitTheBudget(hub)
    }

    /// Too little left after the wait to be worth a request: stop instead.
    func testNoAttemptStartsWithTooLittleBudgetLeft() async {
        let limited = Reply(
            status: 503, body: unavailableBody, headers: ["Retry-After": "7.8"])
        let hub = FakeHub([.reply(limited), signal])
        do {
            _ = try await client(hub).attach(controllerId: "c1")
            XCTFail("expected the retry to give up")
        } catch TraySignalingError.retriesExhausted(let attempts, _) {
            XCTAssertEqual(attempts, 1)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(hub.requests, 1)
        XCTAssertEqual(hub.sleeps, [])
    }

    /// A hub that holds the request open is cut off at the deadline, the way
    /// Go's request context is, instead of answering whenever it likes.
    func testAStalledAttemptIsCancelledAtTheDeadline() async {
        let hub = FakeHub([.stall(seconds: 2, then: Reply(status: 200, body: signalBody))])
        let timer: @Sendable (TimeInterval) async throws -> Void = { hub.sleep($0) }
        do {
            let plan = try await client(hub, attemptTimer: timer).attach(controllerId: "c1")
            XCTFail("expected the stalled attempt to time out, got \(plan.code)")
        } catch TraySignalingError.retriesExhausted(let attempts, .networkError(let underlying)) {
            XCTAssertEqual(attempts, 1)
            XCTAssertEqual((underlying as? URLError)?.code, .timedOut)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(hub.requests, 1)
        XCTAssertLessThanOrEqual(hub.elapsedSeconds, 8 + 1e-9)
        assertAttemptsFitTheBudget(hub)
    }

    func testA429HonoursRetryAfter() async throws {
        let limited = Reply(status: 429, body: #"{"error":"slow down"}"#, headers: ["Retry-After": "3"])
        let hub = FakeHub([.reply(limited), signal])
        let plan = try await client(hub).attach(controllerId: "c1")
        XCTAssertEqual(plan.action, .signal)
        XCTAssertEqual(hub.sleeps, [3])
    }

    /// A `Retry-After` the budget cannot cover ends the call at once.
    func testA429WhoseRetryAfterOutlastsTheBudgetGivesUpWithoutWaiting() async {
        let limited = Reply(status: 429, body: #"{"error":"slow down"}"#, headers: ["Retry-After": "60"])
        let hub = FakeHub([.reply(limited), signal])
        do {
            _ = try await client(hub).attach(controllerId: "c1")
            XCTFail("expected the retry to give up")
        } catch TraySignalingError.retriesExhausted(let attempts, _) {
            XCTAssertEqual(attempts, 1)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(hub.requests, 1)
        XCTAssertEqual(hub.sleeps, [])
    }

    func testA400IsNotRetried() async {
        let hub = FakeHub([.reply(Reply(status: 400, body: #"{"error":"bad request"}"#)), signal])
        do {
            _ = try await client(hub).attach(controllerId: "c1")
            XCTFail("expected a 400 to fail")
        } catch TraySignalingError.invalidAttachResponse(let status, _) {
            XCTAssertEqual(status, 400)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(hub.requests, 1)
        XCTAssertEqual(hub.sleeps, [])
    }

    /// A named successor is a hop, never a transient fault — even on a 5xx with
    /// a body this build cannot read.
    func testTheSupersedeCaseIsNotRetried() async throws {
        let moved = Reply(
            status: 503, body: "upstream moved",
            headers: ["Link": #"<https://www.sliccy.ai/join/fresh.beef>; rel="successor-version""#])
        let hub = FakeHub([.reply(moved), signal])
        let plan = try await client(hub).attach(controllerId: "c1")
        XCTAssertEqual(plan.supersededByJoinUrl, "https://www.sliccy.ai/join/fresh.beef")
        XCTAssertEqual(plan.code, "TRAY_SUPERSEDED")
        XCTAssertEqual(hub.requests, 1)
        XCTAssertEqual(hub.sleeps, [])
    }

    func testACancelledRequestIsNotRetried() async {
        let hub = FakeHub([.fail(URLError(.cancelled)), signal])
        do {
            _ = try await client(hub).attach(controllerId: "c1")
            XCTFail("expected cancellation to surface")
        } catch TraySignalingError.networkError {
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(hub.requests, 1)
    }

    /// Bootstrap polls share the same POST, so a reset mid-bootstrap recovers too.
    func testABootstrapPollRetriesA503() async throws {
        let pollBody = #"""
            {"trayId":"t1","controllerId":"c1","role":"follower","leader":null,
             "participantCount":2,
             "bootstrap":{"controllerId":"c1","bootstrapId":"b1","attempt":1,
                          "state":"pending","expiresAt":"2026-10-24T00:00:00Z",
                          "maxRetries":2,"retriesRemaining":2,
                          "cursor":0,"failure":null},
             "events":[]}
            """#
        let hub = FakeHub([unavailable, .reply(Reply(status: 200, body: pollBody))])
        let plan = try await client(hub).pollBootstrap(
            controllerId: "c1", bootstrapId: "b1", cursor: 0)
        XCTAssertEqual(plan.bootstrap.bootstrapId, "b1")
        XCTAssertEqual(hub.requests, 2)
    }

    func testRetryAfterParsesSecondsAndHTTPDates() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func response(_ value: String) -> HTTPURLResponse {
            HTTPURLResponse(
                url: joinUrl, statusCode: 429, httpVersion: nil,
                headerFields: ["Retry-After": value])!
        }
        XCTAssertEqual(TraySignalingRetry.retryAfter(in: response("2"), now: now), 2)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        let date = formatter.string(from: now.addingTimeInterval(5))
        XCTAssertEqual(TraySignalingRetry.retryAfter(in: response(date), now: now), 5)
        XCTAssertNil(TraySignalingRetry.retryAfter(in: response("soon"), now: now))
        XCTAssertNil(TraySignalingRetry.retryAfter(in: response("-1"), now: now))
    }
}
