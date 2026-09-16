import Foundation
import SliccTrayKit

enum ToolCallPathHints {

    static let maximumStrings = 24

    static let maximumStringLength = 4000

    static let maximumHintsPerCall = 8

    private static let urlRegex: NSRegularExpression? = {
        try? NSRegularExpression(pattern: #"\b[a-z][a-z0-9+.-]*://\S+"#, options: [.caseInsensitive])
    }()

    static func hints(from input: AnyCodable?) -> [String] {
        var strings: [String] = []
        collect(input?.value, depth: 0, into: &strings)

        var hints: [String] = []
        var seen = Set<String>()
        for raw in strings {

            let text = blankURLs(in: raw)
            for mention in FileMentions.scan(text) where mention.path.contains("/") {

                guard !seen.contains(mention.path) else { continue }
                seen.insert(mention.path)
                hints.append(mention.path)
                if hints.count >= maximumHintsPerCall { return hints }
            }
        }
        return hints
    }

    private static func blankURLs(in text: String) -> String {
        guard let urlRegex else { return text }
        return urlRegex.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: " ")
    }

    private static func collect(_ value: Any?, depth: Int, into out: inout [String]) {
        guard out.count < maximumStrings else { return }
        if let string = value as? String {
            out.append(String(string.prefix(maximumStringLength)))
            return
        }
        guard depth < 2 else { return }

        if let array = value as? [Any?] {
            for element in array { collect(element, depth: depth + 1, into: &out) }
        } else if let array = value as? [Any] {
            for element in array { collect(element, depth: depth + 1, into: &out) }
        } else if let dict = value as? [String: Any?] {
            for element in dict.values { collect(element, depth: depth + 1, into: &out) }
        } else if let dict = value as? [String: Any] {
            for element in dict.values { collect(element, depth: depth + 1, into: &out) }
        }
    }
}

final class FileMentionResolver: @unchecked Sendable {

    static let defaultTTL: TimeInterval = 30

    static let maximumCacheEntries = 512

    static let maximumHints = 256

    typealias StatProbe = @Sendable (String) async -> Bool

    private let probe: StatProbe
    private let ttl: TimeInterval
    private let now: @Sendable () -> Date

    private let lock = NSLock()
    private var verdicts: [String: (path: String?, at: Date)] = [:]
    private var hintList: [String] = []
    private var hintSet: Set<String> = []

    init(
        ttl: TimeInterval = FileMentionResolver.defaultTTL,
        now: @escaping @Sendable () -> Date = Date.init,
        probe: @escaping StatProbe
    ) {
        self.probe = probe
        self.ttl = ttl
        self.now = now
    }

    func absorb(toolInput: AnyCodable?) {
        let harvested = ToolCallPathHints.hints(from: toolInput)
        guard !harvested.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        for path in harvested where !hintSet.contains(path) {
            hintSet.insert(path)
            hintList.append(path)
        }
        while hintList.count > Self.maximumHints {
            hintSet.remove(hintList.removeFirst())
        }
    }

    var hints: [String] {
        lock.lock()
        defer { lock.unlock() }
        return hintList
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        verdicts.removeAll()
        hintList.removeAll()
        hintSet.removeAll()
    }

    func resolve(_ query: String) async -> String? {
        if let cached = cachedVerdict(for: query) { return cached }
        let path = await lookUp(query)
        remember(query: query, path: path)
        return path
    }

    func resolve(all queries: [String]) async -> [String: String] {
        var resolved: [String: String] = [:]
        for query in Set(queries) {
            if let path = await resolve(query) { resolved[query] = path }
        }
        return resolved
    }

    private func cachedVerdict(for query: String) -> String?? {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = verdicts[query] else { return nil }
        guard now().timeIntervalSince(entry.at) < ttl else {
            verdicts[query] = nil
            return nil
        }
        return .some(entry.path)
    }

    private func remember(query: String, path: String?) {
        lock.lock()
        defer { lock.unlock() }
        if verdicts.count >= Self.maximumCacheEntries { verdicts.removeAll() }
        verdicts[query] = (path, now())
    }

    private func lookUp(_ query: String) async -> String? {
        let normalized = Self.normalize(query)
        guard !normalized.isEmpty else { return nil }

        if query.hasPrefix("/") {
            return await probe(query) ? query : nil
        }

        for candidate in candidateHints(for: normalized) {
            guard await probe(candidate) else { continue }
            return candidate
        }
        return nil
    }

    private func candidateHints(for normalized: String) -> [String] {
        lock.lock()
        let all = hintList
        lock.unlock()

        return all.reversed().filter { Self.matchesSuffix($0, normalized) }
    }

    static func normalize(_ query: String) -> String {
        var path = query.trimmingCharacters(in: .whitespaces)
        while path.hasPrefix("./") || path.hasPrefix("../") {
            path.removeFirst(path.hasPrefix("./") ? 2 : 3)
        }
        if path.hasPrefix("~/") { path.removeFirst(2) }
        while let range = path.range(of: "//") { path.replaceSubrange(range, with: "/") }
        return path
    }

    static func matchesSuffix(_ candidate: String, _ query: String) -> Bool {
        if candidate == query { return true }
        guard candidate.hasSuffix(query) else { return false }
        let boundary = candidate.index(candidate.endIndex, offsetBy: -query.count - 1, limitedBy: candidate.startIndex)
        guard let boundary else { return false }
        return candidate[boundary] == "/"
    }
}
