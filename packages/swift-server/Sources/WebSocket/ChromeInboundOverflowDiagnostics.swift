import Foundation











enum ChromeInboundOverflowDiagnostics {
    static let defaultTopMethodCount = 5

    
    
    
    
    
    
    
    
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
