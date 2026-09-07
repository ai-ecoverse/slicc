import Foundation

/// Attribution for a Chrome→Client inbound overflow.
///
/// When `ChromeInboundMessagePump` hits its cap the proxy kills the Chrome leg
/// and every CDP session dies with it (issue #2417). The log used to say only
/// how many frames were queued, which never explains *what* stormed — in
/// practice a leaked CDP session per tab switch, each one re-emitting the same
/// `Page.*` / `Network.*` events. Summarising the queued frames by method and
/// counting the distinct sessions they came from makes the next storm
/// attributable from the log alone: many methods over few sessions is a busy
/// page, one method over many sessions is a session leak.
enum ChromeInboundOverflowDiagnostics {
    static let defaultTopMethodCount = 5

    /// One-line summary of the queued frames, ordered by count (ties broken by
    /// method name so the line is stable and testable).
    ///
    /// Frames larger than `CDPProxy.cdpProxyInspectBytes` are only scanned up
    /// to that prefix — Chrome serialises `sessionId` last, so a huge frame may
    /// count toward `topMethods` without contributing a session. Both keys are
    /// read with a bounded string scan rather than a JSON decode: this runs on
    /// the socket callback path of a socket that is already failing.
    static func summary(
        for messages: [ProxyMessage],
        topMethodCount: Int = defaultTopMethodCount
    ) -> String {
        var methodCounts: [String: Int] = [:]
        var sessionIds: Set<String> = []
        var binaryCount = 0

        for message in messages {
            guard case .text(let text) = message else {
                binaryCount += 1
                continue
            }

            let scanned =
                text.count > CDPProxy.cdpProxyInspectBytes
                ? String(text.prefix(CDPProxy.cdpProxyInspectBytes)) : text
            if let method = self.jsonStringValue(forKey: "method", in: scanned) {
                methodCounts[method, default: 0] += 1
            }
            if let sessionId = self.jsonStringValue(forKey: "sessionId", in: scanned) {
                sessionIds.insert(sessionId)
            }
        }

        let topMethods =
            methodCounts
            .sorted { lhs, rhs in
                lhs.value == rhs.value ? lhs.key < rhs.key : lhs.value > rhs.value
            }
            .prefix(max(0, topMethodCount))
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: ", ")

        var summary =
            "queued=\(messages.count) distinctSessionIds=\(sessionIds.count) "
            + "topMethods: \(topMethods.isEmpty ? "none" : topMethods)"
        if binaryCount > 0 {
            summary += " (binaryFrames=\(binaryCount))"
        }
        return summary
    }

    /// Read `"<key>":"<value>"` out of a CDP frame without decoding it. CDP
    /// method and session identifiers never contain escapes, so the value ends
    /// at the next quote.
    private static func jsonStringValue(forKey key: String, in text: String) -> String? {
        guard let keyRange = text.range(of: "\"\(key)\":\"") else {
            return nil
        }

        let remainder = text[keyRange.upperBound...]
        guard let valueEnd = remainder.firstIndex(of: "\"") else {
            return nil
        }

        let value = String(remainder[..<valueEnd])
        return value.isEmpty ? nil : value
    }
}
