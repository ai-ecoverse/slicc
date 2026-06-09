import XCTest
@testable import Sliccstart

/// Drives the retry loop in `TrayStatusProbe.discoverJoinUrl` through its
/// injectable `fetch` closure so we don't touch the network. The behaviors
/// pinned here are the contract Sliccstart relies on for follower auto-
/// attach: returns the join URL once present, treats `state == "connecting"`
/// as "retry", swallows transport errors, and gives up after the cap.
final class TrayStatusProbeTests: XCTestCase {

    func testReturnsJoinUrlOnFirstSuccessfulRead() async {
        let payload = #"{"state":"connected","joinUrl":"https://example.test/join/abc.def"}"#
        let probe = TrayStatusProbe(fetch: { _ in (200, Data(payload.utf8)) })

        let joinUrl = await probe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:5710",
            maxAttempts: 1,
            retryDelay: 0
        )

        XCTAssertEqual(joinUrl, "https://example.test/join/abc.def")
    }

    func testRetriesWhileLeaderIsConnectingAndReturnsLaterUrl() async {
        let connecting = Data(#"{"state":"connecting"}"#.utf8)
        let ready = Data(#"{"state":"connected","joinUrl":"https://example.test/join/x.y"}"#.utf8)

        actor Counter {
            var count = 0
            func tick() -> Int { count += 1; return count }
        }
        let counter = Counter()
        let probe = TrayStatusProbe(fetch: { _ in
            let n = await counter.tick()
            return n < 3 ? (200, connecting) : (200, ready)
        })

        let joinUrl = await probe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:5710",
            maxAttempts: 5,
            retryDelay: 0
        )

        XCTAssertEqual(joinUrl, "https://example.test/join/x.y")
        let final = await counter.count
        XCTAssertEqual(final, 3, "probe must retry until joinUrl is present")
    }

    func testReturnsNilWhenAllAttemptsAreErrors() async {
        let probe = TrayStatusProbe(fetch: { _ in
            throw URLError(.cannotConnectToHost)
        })

        let joinUrl = await probe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:5710",
            maxAttempts: 3,
            retryDelay: 0
        )

        XCTAssertNil(joinUrl)
    }

    func testReturnsNilWhenLeaderNeverReportsJoinUrl() async {
        let connecting = Data(#"{"state":"connecting"}"#.utf8)
        let probe = TrayStatusProbe(fetch: { _ in (200, connecting) })

        let joinUrl = await probe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:5710",
            maxAttempts: 2,
            retryDelay: 0
        )

        XCTAssertNil(joinUrl)
    }

    func testIgnoresEmptyJoinUrl() async {
        let payload = Data(#"{"state":"connected","joinUrl":""}"#.utf8)
        let probe = TrayStatusProbe(fetch: { _ in (200, payload) })

        let joinUrl = await probe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:5710",
            maxAttempts: 1,
            retryDelay: 0
        )

        XCTAssertNil(joinUrl)
    }

    func testReturnsNilForUnparseableJsonAndDoesNotThrow() async {
        let probe = TrayStatusProbe(fetch: { _ in (200, Data("not-json".utf8)) })

        let joinUrl = await probe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:5710",
            maxAttempts: 1,
            retryDelay: 0
        )

        XCTAssertNil(joinUrl)
    }

    func testStopsAtMaxAttemptsAndDoesNotSpinUnboundedly() async {
        actor Hits { var n = 0; func bump() { n += 1 } }
        let hits = Hits()
        let probe = TrayStatusProbe(fetch: { _ in
            await hits.bump()
            throw URLError(.timedOut)
        })

        _ = await probe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:5710",
            maxAttempts: 4,
            retryDelay: 0
        )

        let count = await hits.n
        XCTAssertEqual(count, 4, "probe must respect the attempt cap")
    }
}
