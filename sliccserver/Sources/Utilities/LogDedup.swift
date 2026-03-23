import Foundation

final class CliLogDedup: @unchecked Sendable {
    private let prefix: String
    private let bufferSize: Int
    private let window: TimeInterval
    private let sink: @Sendable (String) -> Void
    private let queue = DispatchQueue(label: "slicc.cli-log-dedup")
    private var entries: [Entry] = []

    init(
        prefix: String = "[cdp-proxy]",
        bufferSize: Int = 10,
        window: TimeInterval = 60,
        sink: @escaping @Sendable (String) -> Void = { print($0) }
    ) {
        self.prefix = prefix
        self.bufferSize = bufferSize
        self.window = window
        self.sink = sink
    }

    func shouldLog(_ message: String) -> Bool {
        let (shouldLog, flushedMessages) = queue.sync { () -> (Bool, [String]) in
            let fingerprint = makeFingerprint(message)
            let now = Date().timeIntervalSince1970
            var flushedMessages: [String] = []

            flushedMessages.append(contentsOf: evictEntries(olderThan: now))

            if let index = entries.firstIndex(where: { $0.fingerprint == fingerprint }) {
                entries[index].count += 1
                return (false, flushedMessages)
            }

            if entries.count >= bufferSize {
                let evicted = entries.removeFirst()
                if let message = flushMessage(for: evicted) {
                    flushedMessages.append(message)
                }
            }

            entries.append(Entry(
                fingerprint: fingerprint,
                count: 0,
                firstSeen: now,
                sample: String(message.prefix(120))
            ))
            return (true, flushedMessages)
        }

        flushedMessages.forEach(sink)
        return shouldLog
    }

    func flush() {
        let flushedMessages = queue.sync { () -> [String] in
            defer { entries.removeAll() }
            return entries.compactMap(flushMessage(for:))
        }
        flushedMessages.forEach(sink)
    }

    private func evictEntries(olderThan now: TimeInterval) -> [String] {
        var flushedMessages: [String] = []
        while let first = entries.first, now - first.firstSeen > window {
            let evicted = entries.removeFirst()
            if let message = flushMessage(for: evicted) {
                flushedMessages.append(message)
            }
        }
        return flushedMessages
    }

    private func flushMessage(for entry: Entry) -> String? {
        guard entry.count > 0 else { return nil }
        return "\(prefix) (suppressed \(entry.count) similar: \"\(entry.sample)\")"
    }
}

private struct Entry: Sendable {
    let fingerprint: String
    var count: Int
    let firstSeen: TimeInterval
    let sample: String
}

private func makeFingerprint(_ message: String) -> String {
    uuidRegex
        .stringByReplacingMatches(in: message, range: message.nsRange, withTemplate: "<id>")
        .replacingMatches(of: hexRegex, with: "<hex>")
        .replacingMatches(of: objectRegex, with: "{…}")
        .replacingMatches(of: arrayRegex, with: "[…]"
        )
        .replacingMatches(of: numberRegex, with: "<n>")
}

private let uuidRegex = try! NSRegularExpression(
    pattern: #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"#,
    options: [.caseInsensitive]
)
private let hexRegex = try! NSRegularExpression(pattern: #"\b[0-9A-Fa-f]{8,}\b"#)
private let objectRegex = try! NSRegularExpression(pattern: #"\{[^}]{20,}\}"#)
private let arrayRegex = try! NSRegularExpression(pattern: #"\[[^\]]{20,}\]"#)
private let numberRegex = try! NSRegularExpression(pattern: #"\b\d+(\.\d+)?\b"#)

private extension String {
    var nsRange: NSRange {
        NSRange(startIndex..<endIndex, in: self)
    }

    func replacingMatches(of regex: NSRegularExpression, with template: String) -> String {
        regex.stringByReplacingMatches(in: self, range: nsRange, withTemplate: template)
    }
}