import Foundation
import SliccTrayKit

// MARK: - Tool-call path hints

/// File paths the agent has already NAMED IN A TOOL CALL — the Swift mirror of
/// the web's `core/tool-call-paths.ts`.
///
/// `FileMentions` guesses names out of prose and `FileMentionResolver` checks
/// the guess against the leader. That pair has one blind spot: prose almost
/// never carries a directory. When the agent writes "I put it in foo.md", a
/// bare name has nowhere to `stat`.
///
/// The turn itself already contains the answer. A `bash` call running
/// `echo hi > /home/lars/foo.md`, or a `write_file` whose `path` is
/// `/workspace/docs/foo.md`, says exactly which `foo.md` the next sentence
/// means. This harvests those paths so the resolver can prefer them.
///
/// Every string in the input bag is scanned with the SAME heuristic used on
/// prose, and only candidates carrying a directory survive — tools are
/// open-ended, so a table of "the fields that hold paths" would be stale the
/// day it was written.
enum ToolCallPathHints {
    /// How many strings deep in one input bag are worth scanning.
    static let maximumStrings = 24
    /// Longest string scanned. A `write_file` body is content, not parameters.
    static let maximumStringLength = 4000
    /// Hints kept per tool call.
    static let maximumHintsPerCall = 8

    /// `https://host/path.js` is a URL; its "path" is not a file here.
    private static let urlRegex: NSRegularExpression? = {
        try? NSRegularExpression(pattern: #"\b[a-z][a-z0-9+.-]*://\S+"#, options: [.caseInsensitive])
    }()

    /// Every directory-qualified path named by one tool call, in order, deduped
    /// and capped. Nothing here checks existence — that is the resolver's job,
    /// and doing it here would put a `stat` on the render path of every row.
    static func hints(from input: AnyCodable?) -> [String] {
        var strings: [String] = []
        collect(input?.value, depth: 0, into: &strings)

        var hints: [String] = []
        var seen = Set<String>()
        for raw in strings {
            // Blank out URLs first: `https://example.com/app.js` would
            // otherwise contribute `example.com/app.js`, a hint that can never
            // resolve.
            let text = blankURLs(in: raw)
            for mention in FileMentions.scan(text) where mention.path.contains("/") {
                // A bare basename adds nothing the leader could not already
                // find; only a qualified path disambiguates.
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

    /// Shallow on purpose: parameters live at the top level or one container
    /// deep, and descending further means walking arbitrary tool payloads for
    /// diminishing returns.
    private static func collect(_ value: Any?, depth: Int, into out: inout [String]) {
        guard out.count < maximumStrings else { return }
        if let string = value as? String {
            out.append(String(string.prefix(maximumStringLength)))
            return
        }
        guard depth < 2 else { return }
        // `AnyCodable` decodes containers as `[Any?]` / `[String: Any?]`, so
        // both the optional and non-optional element types have to be tried —
        // a cast to only one of them silently skips every nested bag.
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

// MARK: - Resolver

/// Turning a file MENTION into a leader VFS PATH.
///
/// `FileMentions.scan` is a guess made from prose; this is the half that
/// checks it, because the two are asymmetric — the heuristic can afford to be
/// wrong, the link the user taps cannot.
///
/// ## Why this is not the web resolver
///
/// The browser builds a basename index by WALKING its own VFS: thousands of
/// entries, all local, all synchronous-ish. The follower has no VFS. Every
/// lookup is an `fs.request` over the data channel to the leader, so a walk
/// would be thousands of round-trips to render one bubble — which is why the
/// follower resolves only what it can settle in a single `stat`:
///
///  - an ABSOLUTE path, which names its own answer;
///  - a partial path or bare name that matches a path the turn's own tool
///    calls already named (`ToolCallPathHints`).
///
/// Anything else stays plain text. That is a real capability gap against the
/// leader tab, and the correct one: the alternative is a transcript that
/// stalls on a `find`-shaped message.
///
/// Not an `ObservableObject` on purpose. The transcript reads it from the
/// environment, and a published change here would invalidate every row on
/// screen — the same rule that keeps `AppState.toolProgress` sliced per row
/// (see `MessageBubble`'s `Equatable` conformance).
final class FileMentionResolver: @unchecked Sendable {

    /// How long a verdict stays fresh.
    ///
    /// Agents create files mid-conversation and then name them, so caching for
    /// the life of the view would leave exactly those mentions unlinkable.
    static let defaultTTL: TimeInterval = 30

    /// Hard ceiling on remembered verdicts, so a long session cannot grow this
    /// without bound.
    static let maximumCacheEntries = 512

    /// Hard ceiling on remembered hints, newest wins.
    static let maximumHints = 256

    /// What the resolver asks the leader. Injected so tests never need a tray.
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

    /// Record the paths one tool call named. Called as rows arrive, before the
    /// prose that references them is rendered.
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

    /// Every hint currently known, oldest first. Test seam and diagnostics.
    var hints: [String] {
        lock.lock()
        defer { lock.unlock() }
        return hintList
    }

    /// Drop every verdict and hint. Used when the follower detaches — a new
    /// leader has a different filesystem, and a stale confirmation would open
    /// a preview of a file that is not there.
    func reset() {
        lock.lock()
        defer { lock.unlock() }
        verdicts.removeAll()
        hintList.removeAll()
        hintSet.removeAll()
    }

    /// Resolve one mention to a leader path, or `nil` when nothing confirms it.
    func resolve(_ query: String) async -> String? {
        if let cached = cachedVerdict(for: query) { return cached }
        let path = await lookUp(query)
        remember(query: query, path: path)
        return path
    }

    /// Resolve a whole message's mentions at once, returning only the
    /// confirmed ones keyed by the text that was written.
    func resolve(all queries: [String]) async -> [String: String] {
        var resolved: [String: String] = [:]
        for query in Set(queries) {
            if let path = await resolve(query) { resolved[query] = path }
        }
        return resolved
    }

    // MARK: - Internals

    /// `nil` outer means "not decided yet"; `.some(nil)` means "known not a
    /// file", which is a verdict worth caching — it is the common case.
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
        // Sequential rather than concurrent: the hints are already ordered
        // newest-first, so the first hit is the answer and every probe after
        // it would be a round trip spent to learn nothing.
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
        // Newest first: when the agent wrote two `notes.md` this turn, the one
        // it just touched is the one the sentence means.
        return all.reversed().filter { Self.matchesSuffix($0, normalized) }
    }

    /// Strip the prefixes people actually type. None of them survives a suffix
    /// match — no leader path ends with a literal `~/` or `../` segment — so
    /// each is reduced to the meaningful tail, which the suffix rule then
    /// matches at a segment boundary wherever it really lives.
    static func normalize(_ query: String) -> String {
        var path = query.trimmingCharacters(in: .whitespaces)
        while path.hasPrefix("./") || path.hasPrefix("../") {
            path.removeFirst(path.hasPrefix("./") ? 2 : 3)
        }
        if path.hasPrefix("~/") { path.removeFirst(2) }
        while let range = path.range(of: "//") { path.replaceSubrange(range, with: "/") }
        return path
    }

    /// Whether a full leader path satisfies the partial path `query`.
    ///
    /// Matching on a SUFFIX at a segment boundary is what makes
    /// `webapp/src/main.ts` resolve to `/packages/webapp/src/main.ts` while
    /// refusing `/other/xwebapp/src/main.ts`.
    static func matchesSuffix(_ candidate: String, _ query: String) -> Bool {
        if candidate == query { return true }
        guard candidate.hasSuffix(query) else { return false }
        let boundary = candidate.index(candidate.endIndex, offsetBy: -query.count - 1, limitedBy: candidate.startIndex)
        guard let boundary else { return false }
        return candidate[boundary] == "/"
    }
}
