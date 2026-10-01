import Foundation

/// GitHub refused (or told us to stop sending) API requests until `retryAfter`.
struct GitHubRateLimitedError: Error, Equatable {
    let retryAfter: Date
}

/// Reads GitHub's REST rate-limit headers, following
/// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately
///
/// Anonymous requests share a 60/hour budget per IP, so behind a corporate VPN
/// or NAT the budget is routinely drained by other people. Ignoring the
/// headers turns that into an opaque `badServerResponse` and keeps spending
/// requests the network no longer has.
enum GitHubRateLimit {
    /// GitHub: when a rate-limit response carries neither `retry-after` nor an
    /// exhausted `x-ratelimit-remaining`, wait at least one minute.
    static let minimumBackoff: TimeInterval = 60

    /// The time before which no further request should be sent, or `nil` when
    /// `response` imposes no wait.
    ///
    /// - `retry-after` on a 403/429 wins (secondary limits).
    /// - `x-ratelimit-remaining: 0` waits for `x-ratelimit-reset` — also on a
    ///   success, so the walk stops before it earns a 403.
    /// - A 429, or an exhausted 403 without a reset, waits `minimumBackoff`.
    /// - A 403 with no rate-limit signal is a real "forbidden", not a limit.
    static func blockedUntil(_ response: HTTPURLResponse, now: Date) -> Date? {
        let isLimitStatus = response.statusCode == 403 || response.statusCode == 429
        if isLimitStatus, let seconds = header(response, "Retry-After").flatMap(TimeInterval.init) {
            return now.addingTimeInterval(max(seconds, 0))
        }
        let exhausted = header(response, "X-RateLimit-Remaining").flatMap(Int.init) == 0
        let reset = header(response, "X-RateLimit-Reset")
            .flatMap(TimeInterval.init)
            .map(Date.init(timeIntervalSince1970:))
        if exhausted, let reset, reset > now {
            return reset
        }
        if response.statusCode == 429 || (isLimitStatus && exhausted) {
            return now.addingTimeInterval(minimumBackoff)
        }
        return nil
    }

    private static func header(_ response: HTTPURLResponse, _ name: String) -> String? {
        response.value(forHTTPHeaderField: name)?.trimmingCharacters(in: .whitespaces)
    }
}

/// Remembers a rate-limit wait across update checks, so a re-check before
/// the reset fails locally instead of spending another request.
final class GitHubRateLimitGate: @unchecked Sendable {
    private let lock = NSLock()
    private var blockedUntil: Date?

    func check(now: Date) throws {
        try lock.withLock {
            if let blockedUntil, now < blockedUntil {
                throw GitHubRateLimitedError(retryAfter: blockedUntil)
            }
        }
    }

    func record(_ until: Date?) {
        guard let until else { return }
        lock.withLock { blockedUntil = until }
    }
}
