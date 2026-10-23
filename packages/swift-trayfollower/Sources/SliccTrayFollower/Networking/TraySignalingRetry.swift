import Foundation

/// The bounded retry `TraySignalingClient` puts around every hub POST.
///
/// A deploy resets the tray Durable Object for a few seconds. The hub answers
/// that with JSON `503 TRAY_TEMPORARILY_UNAVAILABLE` (`retryable: true`), and
/// an uncaught reset still arrives as Cloudflare's plain-text "error code:
/// 1101" page. Both are safe to repeat: nothing has reached the leader yet.
/// Mirrors `postWithMeta` / `transientResponse` in
/// `packages/slicc-cli/internal/signaling/signaling.go` — four attempts,
/// 1 s → 4 s backoff, everything inside an 8 s budget — plus 429 with
/// `Retry-After`, which the Go twin does not special-case.
///
/// The clock, sleep and jitter are seams so tests run without waiting.
struct TraySignalingRetry: Sendable {
    var maxAttempts = 4
    var baseDelay: TimeInterval = 1
    var maxDelay: TimeInterval = 4
    var budget: TimeInterval = 8
    var now: @Sendable () -> Date = { Date() }
    var sleep: @Sendable (TimeInterval) async throws -> Void = { seconds in
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
    /// Spreads followers that hit the same reset so they do not return in step.
    var jitter: @Sendable (TimeInterval) -> TimeInterval = { $0 * Double.random(in: 0.8...1.2) }

    static let standard = TraySignalingRetry()

    /// Whether the hub's reply is worth sending again. A named successor never
    /// is: the tray moved, and retrying the old URL cannot finish the hop
    /// (#1957). Any other 4xx is the hub's final word on this request.
    static func isTransient(data: Data, response: HTTPURLResponse) -> Bool {
        if SupersedeLink.successor(in: response) != nil
            || SupersedeLink.redirectTarget(in: response) != nil
        {
            return false
        }
        let status = response.statusCode
        if status >= 500 || status == 429 { return true }
        if (400..<500).contains(status) { return false }
        // A 2xx/3xx the hub did not write — an edge error page in place of JSON.
        let text =
            String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return false }
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed))
            == nil
    }

    /// `Retry-After` as a delay from `now`: delta-seconds or an HTTP-date.
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

    /// A cancelled request is the caller leaving, not a flaky network.
    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }
}
