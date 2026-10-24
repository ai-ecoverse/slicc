import Foundation













struct TraySignalingRetry: Sendable {
    var maxAttempts = 4
    var baseDelay: TimeInterval = 1
    var maxDelay: TimeInterval = 4
    var budget: TimeInterval = 8
    
    var minAttemptTime: TimeInterval = 0.5
    var now: @Sendable () -> Date = { Date() }
    var sleep: @Sendable (TimeInterval) async throws -> Void = { seconds in
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
    
    
    var attemptTimer: @Sendable (TimeInterval) async throws -> Void = { seconds in
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
    
    var jitter: @Sendable (TimeInterval) -> TimeInterval = { $0 * Double.random(in: 0.8...1.2) }

    static let standard = TraySignalingRetry()

    
    
    
    static func isTransient(data: Data, response: HTTPURLResponse) -> Bool {
        if SupersedeLink.successor(in: response) != nil
            || SupersedeLink.redirectTarget(in: response) != nil
        {
            return false
        }
        let status = response.statusCode
        if status >= 500 || status == 429 { return true }
        if (400..<500).contains(status) { return false }
        
        let text =
            String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return false }
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed))
            == nil
    }

    
    static func retryAfter(in response: HTTPURLResponse, now: Date) -> TimeInterval? {
        guard
            let raw = response.value(forHTTPHeaderField: "Retry-After")?
                .trimmingCharacters(in: .whitespaces), !raw.isEmpty
        else { return nil }
        if let seconds = Double(raw) { return seconds >= 0 ? seconds : nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: raw) else { return nil }
        return max(0, date.timeIntervalSince(now))
    }

    
    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }
}
