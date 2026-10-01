import Foundation


struct GitHubRateLimitedError: Error, Equatable {
    let retryAfter: Date
}








enum GitHubRateLimit {
    
    
    static let minimumBackoff: TimeInterval = 60

    
    
    
    
    
    
    
    
    
    
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

    
    
    private static func bodyNamesRateLimit(_ body: Data) -> Bool {
        struct ErrorBody: Decodable { let message: String? }
        let message = (try? JSONDecoder().decode(ErrorBody.self, from: body))?.message
        return message?.range(of: "rate limit", options: .caseInsensitive) != nil
    }

    private static func header(_ response: HTTPURLResponse, _ name: String) -> String? {
        response.value(forHTTPHeaderField: name)?.trimmingCharacters(in: .whitespaces)
    }
}



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
        lock.withLock { blockedUntil = max(blockedUntil ?? until, until) }
    }
}
