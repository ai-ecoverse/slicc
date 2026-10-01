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
    /// - A 429, an exhausted 403 without a reset, or a 403 whose body names a
    ///   rate limit (secondary limits may send neither header) waits
    ///   `minimumBackoff`.
    /// - A 403 with no rate-limit signal is a real "forbidden", not a limit.
    static func blockedUntil(_ response: HTTPURLResponse, body: Data = Data(), now: Date) -> Date? {
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
        if response.statusCode == 429 || (isLimitStatus && (exhausted || bodyNamesRateLimit(body))) {
            return now.addingTimeInterval(minimumBackoff)
        }
        return nil
    }

    /// GitHub's limit errors say so in `message`, e.g. "API rate limit
    /// exceeded" or "You have exceeded a secondary rate limit".
    private static func bodyNamesRateLimit(_ body: Data) -> Bool {
        struct ErrorBody: Decodable { let message: String? }
        let message = (try? JSONDecoder().decode(ErrorBody.self, from: body))?.message
        return message?.range(of: "rate limit", options: .caseInsensitive) != nil
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

    /// Keeps the furthest deadline: overlapping checks can finish out of
    /// order, and an earlier reset must not shorten a longer wait.
    func record(_ until: Date?) {
        guard let until else { return }
        lock.withLock { blockedUntil = max(blockedUntil ?? until, until) }
    }
}
