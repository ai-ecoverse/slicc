import Foundation
import SliccTrayKit

struct FrozenSessionIndexEntry: Codable, Equatable, Identifiable {
    let filename: String
    let title: String

    let frozenAt: String
    let messageCount: Int
    let sessionId: String?
    let icon: String?

    var id: String { sessionId ?? filename }

    var path: String { "/sessions/\(filename)" }

    var frozenDate: Date? {
        FrozenSessionIndex.isoFormatter.date(from: frozenAt)
            ?? FrozenSessionIndex.isoFractionalFormatter.date(from: frozenAt)
    }

    init(
        filename: String,
        title: String,
        frozenAt: String,
        messageCount: Int,
        sessionId: String? = nil,
        icon: String? = nil
    ) {
        self.filename = filename
        self.title = title
        self.frozenAt = frozenAt
        self.messageCount = messageCount
        self.sessionId = sessionId
        self.icon = icon
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        filename = try container.decode(String.self, forKey: .filename)
        title = try container.decode(String.self, forKey: .title)
        frozenAt = try container.decodeIfPresent(String.self, forKey: .frozenAt) ?? ""
        messageCount = try container.decodeIfPresent(Int.self, forKey: .messageCount) ?? 0
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        icon = try container.decodeIfPresent(String.self, forKey: .icon)
    }

    private enum CodingKeys: String, CodingKey {
        case filename, title, frozenAt, messageCount, sessionId, icon
    }
}

enum FrozenSessionIndex {
    static let indexPath = "/sessions/index.json"
    static let sessionsDir = "/sessions"

    static let isoFormatter: ISO8601DateFormatter = ISO8601DateFormatter()
    static let isoFractionalFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func parse(indexJson: String) -> [FrozenSessionIndexEntry]? {
        guard let data = indexJson.data(using: .utf8),
            let raw = try? JSONSerialization.jsonObject(with: data),
            let array = raw as? [Any]
        else { return nil }
        let decoder = JSONDecoder()
        return array.compactMap { element in
            guard let elementData = try? JSONSerialization.data(withJSONObject: element) else {
                return nil
            }
            return try? decoder.decode(FrozenSessionIndexEntry.self, from: elementData)
        }
    }

    static func rebuild(from entries: [TrayFsDirEntry]) -> [FrozenSessionIndexEntry] {
        entries
            .filter { $0.type == .file && $0.name.hasSuffix(".md") && $0.name != "index.json" }
            .map { entry -> FrozenSessionIndexEntry in
                let stem = String(entry.name.dropLast(3))
                let (timestamp, slug) = splitArchiveStem(stem)

                let title =
                    stem.hasPrefix("pending-")
                    ? "Pending session" : (slug.isEmpty ? stem : titleize(slug))
                return FrozenSessionIndexEntry(
                    filename: entry.name,
                    title: title,
                    frozenAt: timestamp ?? "",
                    messageCount: 0
                )
            }
            .sorted { $0.filename > $1.filename }
    }

    static func search(
        _ entries: [FrozenSessionIndexEntry], query: String
    ) -> [FrozenSessionIndexEntry] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return entries }
        return entries.filter { $0.title.localizedCaseInsensitiveContains(trimmed) }
    }

    static func metaLine(for entry: FrozenSessionIndexEntry) -> String {
        var parts: [String] = []
        if let date = entry.frozenDate {
            parts.append(Self.metaDateFormatter.string(from: date))
        }
        if entry.messageCount > 0 {
            parts.append("\(entry.messageCount) turns")
        }
        return parts.isEmpty ? "Archived session" : parts.joined(separator: " · ")
    }

    private static let metaDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    private static func splitArchiveStem(_ stem: String) -> (timestamp: String?, slug: String) {
        let pattern = #"^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(?:-(\d{1,3}))?Z-?(.*)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
            let result = regex.firstMatch(
                in: stem, range: NSRange(stem.startIndex..., in: stem))
        else {
            return (nil, stem.hasPrefix("pending-") ? "Pending session" : stem)
        }
        func group(_ index: Int) -> String {
            guard let range = Range(result.range(at: index), in: stem) else { return "" }
            return String(stem[range])
        }

        let millis = group(4)
        let seconds = millis.isEmpty ? "\(group(3))Z" : "\(group(3)).\(millis)Z"
        let timestamp = "\(group(1)):\(group(2)):\(seconds)"
        return (timestamp, group(5))
    }

    private static func titleize(_ slug: String) -> String {
        slug.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }
}

struct ParsedFrozenArchive {
    let title: String
    let messages: [ChatMessage]
    let usedFallback: Bool
}

enum FrozenArchiveParser {

    static func withFallbackTimestamps(
        _ archive: ParsedFrozenArchive, frozenAt: Date?
    ) -> ParsedFrozenArchive {
        guard archive.usedFallback, let frozenAt else { return archive }
        let ms = frozenAt.timeIntervalSince1970 * 1000
        let messages = archive.messages.map { message in
            message.timestamp == 0
                ? ChatMessage(
                    id: message.id, role: message.role, content: message.content, timestamp: ms)
                : message
        }
        return ParsedFrozenArchive(
            title: archive.title, messages: messages, usedFallback: archive.usedFallback)
    }

    static func parse(markdown: String) -> ParsedFrozenArchive {
        var body = markdown
        var title = "Untitled"

        if let fmRange = body.range(
            of: #"^---\n[\s\S]*?\n---\n+"#, options: .regularExpression)
        {
            let frontmatter = String(body[fmRange])
            body = String(body[fmRange.upperBound...])
            if let titleRange = frontmatter.range(
                of: #"(?m)^title:\s*(.+?)\s*$"#, options: .regularExpression)
            {
                let line = String(frontmatter[titleRange])
                let raw = line.replacingOccurrences(
                    of: #"^title:\s*"#, with: "", options: .regularExpression
                ).trimmingCharacters(in: .whitespaces)
                if raw.hasPrefix("\""),
                    let data = raw.data(using: .utf8),
                    let decoded = try? JSONDecoder().decode(String.self, from: data)
                {
                    title = decoded
                } else if raw.hasPrefix("\"") {
                    title = raw.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                } else if !raw.isEmpty {
                    title = raw
                }
            }
        }

        if let dataRange = body.range(
            of: #"<!-- slicc:session-data\n[\s\S]*?\n-->\n*"#, options: .regularExpression)
        {
            let block = String(body[dataRange])
            let json =
                block
                .replacingOccurrences(
                    of: #"^<!-- slicc:session-data\n"#, with: "", options: .regularExpression
                )
                .replacingOccurrences(of: #"\n-->\n*$"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: "-- >", with: "-->")
            if let data = json.data(using: .utf8),
                let messages = try? JSONDecoder().decode([ChatMessage].self, from: data)
            {
                return ParsedFrozenArchive(title: title, messages: messages, usedFallback: false)
            }

            body.removeSubrange(dataRange)
        }

        body = body.replacingOccurrences(
            of: #"^#\s+[^\n]*\n+"#, with: "", options: .regularExpression)
        return ParsedFrozenArchive(
            title: title, messages: parseHeadingFallback(body), usedFallback: true)
    }

    private static func parseHeadingFallback(_ body: String) -> [ChatMessage] {
        var messages: [ChatMessage] = []
        let pattern = #"(?m)^## (User|Assistant)\s*\n"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = body as NSString
        let matches = regex.matches(in: body, range: NSRange(location: 0, length: ns.length))
        for (index, match) in matches.enumerated() {
            let role: MessageRole =
                ns.substring(with: match.range(at: 1)) == "User" ? .user : .assistant
            let start = match.range.location + match.range.length
            let end =
                index + 1 < matches.count ? matches[index + 1].range.location : ns.length
            let content = ns.substring(with: NSRange(location: start, length: end - start))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            messages.append(
                ChatMessage(
                    id: "frozen-\(index)", role: role, content: content, timestamp: 0))
        }
        return messages
    }
}
