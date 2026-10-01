import AppUpdater
import Version
import XCTest

@testable import Sliccstart

/// GitHub rate-limit handling for the update check. Anonymous API calls
/// share 60/hour per IP, so on a VPN the budget is often gone before
/// Sliccstart asks; the headers say when to come back.
final class GitHubRateLimitTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    private let url = URL(string: "https://api.example.com/repos/o/r/releases")!

    private func response(_ status: Int, _ headers: [String: String] = [:]) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    }

    // MARK: - Header parsing

    func testPrimaryLimitWaitsForTheReset() {
        let reset = now.addingTimeInterval(900)
        let headers = ["x-ratelimit-remaining": "0", "x-ratelimit-reset": "\(Int(reset.timeIntervalSince1970))"]
        XCTAssertEqual(GitHubRateLimit.blockedUntil(response(403, headers), now: now), reset)
        XCTAssertEqual(GitHubRateLimit.blockedUntil(response(429, headers), now: now), reset)
    }

    func testRetryAfterWinsForSecondaryLimits() {
        let headers = ["Retry-After": "120", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700009999"]
        XCTAssertEqual(GitHubRateLimit.blockedUntil(response(403, headers), now: now), now.addingTimeInterval(120))
    }

    func testA429WithoutHeadersWaitsAtLeastAMinute() {
        XCTAssertEqual(
            GitHubRateLimit.blockedUntil(response(429), now: now),
            now.addingTimeInterval(GitHubRateLimit.minimumBackoff)
        )
    }

    func testAnExhaustedLimitWithAStaleResetStillBacksOff() {
        let headers = ["x-ratelimit-remaining": "0", "x-ratelimit-reset": "\(Int(now.timeIntervalSince1970) - 5)"]
        XCTAssertEqual(
            GitHubRateLimit.blockedUntil(response(403, headers), now: now),
            now.addingTimeInterval(GitHubRateLimit.minimumBackoff)
        )
    }

    func testAPlainForbiddenIsNotARateLimit() {
        XCTAssertNil(GitHubRateLimit.blockedUntil(response(403), now: now))
        XCTAssertNil(GitHubRateLimit.blockedUntil(response(403, ["x-ratelimit-remaining": "12"]), now: now))
    }

    func testASecondaryLimitNamedOnlyInTheBodyWaitsAMinute() {
        let body = Data(#"{"message":"You have exceeded a secondary rate limit. Please wait."}"#.utf8)
        XCTAssertEqual(
            GitHubRateLimit.blockedUntil(response(403, ["x-ratelimit-remaining": "42"]), body: body, now: now),
            now.addingTimeInterval(GitHubRateLimit.minimumBackoff)
        )
    }

    func testAForbiddenBodyWithoutARateLimitIsNotALimit() {
        let body = Data(#"{"message":"Resource not accessible by integration"}"#.utf8)
        XCTAssertNil(GitHubRateLimit.blockedUntil(response(403), body: body, now: now))
        XCTAssertNil(GitHubRateLimit.blockedUntil(response(403), body: Data("rate limit".utf8), now: now))
    }

    func testTheGateKeepsTheFurthestDeadline() {
        let gate = GitHubRateLimitGate()
        let later = now.addingTimeInterval(600)
        gate.record(later)
        gate.record(now.addingTimeInterval(60))
        XCTAssertThrowsError(try gate.check(now: now.addingTimeInterval(120))) { error in
            XCTAssertEqual(error as? GitHubRateLimitedError, GitHubRateLimitedError(retryAfter: later))
        }
        XCTAssertNoThrow(try gate.check(now: later))
    }

    func testASuccessWithBudgetLeftImposesNoWait() {
        let headers = ["x-ratelimit-remaining": "59", "x-ratelimit-reset": "1700003600"]
        XCTAssertNil(GitHubRateLimit.blockedUntil(response(200, headers), now: now))
    }

    func testASuccessThatSpentTheLastRequestWaitsForTheReset() {
        let headers = ["x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700003600"]
        XCTAssertEqual(
            GitHubRateLimit.blockedUntil(response(200, headers), now: now),
            Date(timeIntervalSince1970: 1_700_003_600)
        )
    }

    func testRetryAfterIsIgnoredOnSuccess() {
        XCTAssertNil(GitHubRateLimit.blockedUntil(response(200, ["Retry-After": "30"]), now: now))
    }

    // MARK: - Provider

    private final class Responder: @unchecked Sendable {
        private(set) var calls = 0
        let status: Int
        let headers: [String: String]
        let body: String

        init(status: Int, headers: [String: String], body: String = "[]") {
            self.status = status
            self.headers = headers
            self.body = body
        }

        var fetchPage: TolerantGithubReleaseProvider.PageFetcher {
            { [self] request in
                calls += 1
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
                return (Data(body.utf8), response)
            }
        }
    }

    private final class Clock: @unchecked Sendable {
        var now: Date
        init(_ now: Date) { self.now = now }
    }

    private func provider(
        _ responder: Responder,
        gate: GitHubRateLimitGate,
        clock: Clock
    ) -> TolerantGithubReleaseProvider {
        TolerantGithubReleaseProvider(
            authToken: nil,
            host: UpdateHostConfiguration(baseURL: URL(string: "https://api.example.com")!),
            releasePrefix: "Sliccstart",
            currentVersion: Version(0, 0, 0),
            fetchPage: responder.fetchPage,
            rateLimitGate: gate,
            now: { clock.now }
        )
    }

    private func fetch(_ provider: TolerantGithubReleaseProvider) async throws -> [Release] {
        try await provider.fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)
    }

    func testARateLimitedResponseThrowsTheRetryTimeAndGatesTheNextCheck() async throws {
        let reset = now.addingTimeInterval(600)
        let responder = Responder(
            status: 403,
            headers: ["x-ratelimit-remaining": "0", "x-ratelimit-reset": "\(Int(reset.timeIntervalSince1970))"],
            body: #"{"message":"API rate limit exceeded"}"#
        )
        let clock = Clock(now)
        let sut = provider(responder, gate: GitHubRateLimitGate(), clock: clock)

        do {
            _ = try await fetch(sut)
            XCTFail("Expected a rate-limit error")
        } catch {
            XCTAssertEqual(error as? GitHubRateLimitedError, GitHubRateLimitedError(retryAfter: reset))
        }

        clock.now = now.addingTimeInterval(300)
        do {
            _ = try await fetch(sut)
            XCTFail("Expected the gate to refuse before the reset")
        } catch {
            XCTAssertEqual(error as? GitHubRateLimitedError, GitHubRateLimitedError(retryAfter: reset))
        }
        XCTAssertEqual(responder.calls, 1, "No request may be sent before the advertised reset")

        clock.now = reset
        _ = try? await fetch(sut)
        XCTAssertEqual(responder.calls, 2, "The gate opens once the reset has passed")
    }

    func testASuccessThatSpentTheBudgetGatesTheNextCheck() async throws {
        let reset = now.addingTimeInterval(1200)
        let responder = Responder(
            status: 200,
            headers: ["x-ratelimit-remaining": "0", "x-ratelimit-reset": "\(Int(reset.timeIntervalSince1970))"]
        )
        let sut = provider(responder, gate: GitHubRateLimitGate(), clock: Clock(now))

        let releases = try await fetch(sut)
        XCTAssertTrue(releases.isEmpty)
        do {
            _ = try await fetch(sut)
            XCTFail("Expected the gate to refuse a request GitHub would reject")
        } catch {
            XCTAssertEqual(error as? GitHubRateLimitedError, GitHubRateLimitedError(retryAfter: reset))
        }
        XCTAssertEqual(responder.calls, 1)
    }

    func testASecondaryLimitBodyThrowsAndGates() async {
        let responder = Responder(
            status: 403,
            headers: ["x-ratelimit-remaining": "42"],
            body: #"{"message":"You have exceeded a secondary rate limit."}"#
        )
        let sut = provider(responder, gate: GitHubRateLimitGate(), clock: Clock(now))
        let expected = GitHubRateLimitedError(retryAfter: now.addingTimeInterval(GitHubRateLimit.minimumBackoff))

        for _ in 0..<2 {
            do {
                _ = try await fetch(sut)
                XCTFail("Expected a rate-limit error")
            } catch {
                XCTAssertEqual(error as? GitHubRateLimitedError, expected)
            }
        }
        XCTAssertEqual(responder.calls, 1)
    }

    func testAPlainForbiddenStillThrowsBadServerResponseAndDoesNotGate() async {
        let responder = Responder(status: 403, headers: [:])
        let sut = provider(responder, gate: GitHubRateLimitGate(), clock: Clock(now))

        for _ in 0..<2 {
            do {
                _ = try await fetch(sut)
                XCTFail("Expected a forbidden response to throw")
            } catch {
                XCTAssertEqual((error as? URLError)?.code, .badServerResponse)
            }
        }
        XCTAssertEqual(responder.calls, 2)
    }

    // MARK: - Status

    func testRateLimitMapsToItsOwnStatus() {
        let until = now.addingTimeInterval(60)
        let status = UpdateCheckStatus.from(error: GitHubRateLimitedError(retryAfter: until))
        XCTAssertEqual(status, .rateLimited(until: until))
        XCTAssertTrue(status.isRateLimited)
        XCTAssertTrue(status.allowsRetry)
        XCTAssertEqual(status.buttonTitle, "Update Check Rate-Limited")
        XCTAssertTrue(status.detail?.contains("GH_TOKEN") == true)
        XCTAssertFalse(UpdateCheckStatus.failed("x").isRateLimited)
    }
}
