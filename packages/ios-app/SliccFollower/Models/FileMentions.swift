import Foundation

// MARK: - File mentions

/// Finding file names in prose — the Swift mirror of the web's
/// `core/file-mentions.ts`.
///
/// Agents name files constantly and almost never as full paths ("I rewrote
/// the watcher in `check.js`", "packages/webapp/src/main.ts:42"). Those names
/// are the most tappable thing in a transcript and on iOS they were inert.
///
/// This half only extracts CANDIDATES; it deliberately cannot say whether a
/// candidate exists. That answer lives on the leader and arrives
/// asynchronously (`FileMentionResolver`). The split is the web's, and it is
/// load-bearing for the same reason: a missed candidate costs a link the user
/// never gets, while a false candidate costs nothing as long as nothing
/// renders it until the leader confirms it. So the heuristic leans permissive
/// and verification is what makes it safe.
///
/// Kept a byte-for-byte behavioural mirror of the web rules — the same wordy
/// extensions, the same TLD list, the same extensionless names — because a
/// mention that linkifies in the leader tab and stays dead on the phone reads
/// as a bug in the phone.
enum FileMentions {

    /// A file name found in prose, with the span it occupies in the source.
    ///
    /// The span is a CHARACTER offset rather than a `String.Index` because the
    /// scan runs over a masked copy of the caller's text (see `maskingURLs`).
    /// Masking preserves the character count and nothing else, so an offset is
    /// the only thing that survives the round trip.
    struct Candidate: Equatable {
        /// The path with any trailing `:line[:col]` suffix removed.
        let path: String
        /// 1-based line number from a `path:42` suffix, when present.
        let line: Int?
        /// Character offset of the mention in the source string.
        let offset: Int
        /// Length of the mention in characters.
        let length: Int

        var range: Range<Int> { offset..<(offset + length) }
    }

    /// Extensions that read as English words and end sentences far more often
    /// than they name files. `.so` and `.in` are real, but "and so." costs
    /// more than it returns.
    private static let wordyExtensions: Set<String> = [
        "so", "in", "at", "is", "it", "as", "be", "do", "go", "me", "my", "no",
        "of", "on", "or", "to", "up", "us", "we", "am", "an", "by", "if", "ok",
    ]

    /// Hosts whose "extension" is a TLD. `sh` is pointedly ABSENT: shell
    /// scripts are named that way constantly and `sh.ly` domains are
    /// vanishingly rare in a transcript.
    private static let tldLike: Set<String> = [
        "com", "org", "net", "io", "dev", "ai", "app", "co", "gov", "edu",
        "ly", "tv", "xyz", "cloud", "computer", "software",
    ]

    /// Names with no extension that are unambiguously files. Without this a
    /// bare `Makefile` is unlinkable, since every other rule keys off a dot.
    private static let extensionlessFilenames: [String] = [
        "Makefile", "Dockerfile", "Justfile", "Rakefile", "Gemfile", "Procfile",
        "Brewfile", "Vagrantfile", "CODEOWNERS", "LICENSE", "README", "CHANGELOG",
        "AGENTS",
    ]

    /// Optional directory run, base name, dotted extension, optional
    /// `:line:col`. The leading delimiter is CONSUMED rather than expressed as
    /// a lookbehind, matching the web pattern exactly.
    ///
    /// `[` is escaped inside the delimiter class: unlike JavaScript, ICU
    /// treats a bare `[` inside a set as the start of a NESTED set, so the
    /// web pattern copied verbatim compiles to nil and every mention silently
    /// stops being found.
    private static let mentionPattern =
        #"(?:^|[\s(\['"`<>,;=|])((?:~/|\.{1,2}/|/)?(?:[\w.-]+/)*[\w-][\w.-]*\.[A-Za-z0-9]{1,12})((?::\d+){0,2})"#

    private static let mentionRegex: NSRegularExpression? = {
        try? NSRegularExpression(pattern: mentionPattern)
    }()

    private static let extensionlessRegex: NSRegularExpression? = {
        let names = extensionlessFilenames.joined(separator: "|")
        let pattern = #"(?:^|[\s(\['"`<>,;=|])((?:~/|\.{1,2}/|/)?(?:[\w.-]+/)*(?:\#(names)))\b"#
        return try? NSRegularExpression(pattern: pattern)
    }()

    /// Trailing punctuation that belongs to the sentence, not to the name.
    private static let trailingPunctuation = CharacterSet(charactersIn: ".,;:!?)]}'\"`>")

    /// How many candidates one message is allowed to contribute.
    ///
    /// Every survivor costs a `stat` round-trip to the leader over the data
    /// channel, so a pathological paste of a hundred paths must not turn one
    /// bubble into a hundred requests. The cap is generous next to what real
    /// prose carries and small next to what a `find` dump does.
    static let maximumCandidates = 16

    /// A URL, whose "path" is not a file on this machine. Masked before the
    /// scan so `https://example.com/app.js` cannot contribute
    /// `example.com/app.js` — a directory-qualified candidate that looks
    /// plausible, costs a `stat` to disprove, and can never resolve.
    private static let urlRegex: NSRegularExpression? = {
        try? NSRegularExpression(pattern: #"\b[a-z][a-z0-9+.-]*://\S+"#, options: [.caseInsensitive])
    }()

    /// Replace every URL with spaces of the SAME length. Offsets have to
    /// survive: the ranges this returns index into the caller's string, and
    /// the caller uses them to attach a link.
    static func maskingURLs(in text: String) -> String {
        guard let urlRegex else { return text }
        var masked = text
        let matches = urlRegex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        for match in matches.reversed() {
            guard let range = Range(match.range, in: masked) else { continue }
            let width = masked.distance(from: range.lowerBound, to: range.upperBound)
            masked.replaceSubrange(range, with: String(repeating: " ", count: width))
        }
        return masked
    }

    /// Extract every plausible file mention from `text`, in order and without
    /// overlaps.
    static func scan(_ source: String) -> [Candidate] {
        guard !source.isEmpty else { return [] }
        var found: [Candidate] = []
        var claimed: [Range<Int>] = []
        let text = maskingURLs(in: source)

        collect(mentionRegex, in: text, withLineSuffix: true, into: &found, claimed: &claimed)
        collect(extensionlessRegex, in: text, withLineSuffix: false, into: &found, claimed: &claimed)

        found.sort { $0.offset < $1.offset }
        return Array(found.prefix(maximumCandidates))
    }

    private static func collect(
        _ regex: NSRegularExpression?, in text: String, withLineSuffix: Bool,
        into found: inout [Candidate], claimed: inout [Range<Int>]
    ) {
        guard let regex else { return }
        let ns = text as NSString
        let whole = NSRange(location: 0, length: ns.length)
        for match in regex.matches(in: text, range: whole) {
            guard let captured = Range(match.range(at: 1), in: text) else { continue }
            var path = String(text[captured])
            // Strip sentence punctuation the regex swept up: "edit main.ts," → main.ts
            let trimmed = trimTrailing(path)
            if !trimmed.isEmpty { path = trimmed }

            let suffixRange =
                withLineSuffix ? match.range(at: 2) : NSRange(location: NSNotFound, length: 0)
            let suffix = suffixRange.location == NSNotFound ? "" : ns.substring(with: suffixRange)

            let offset = text.distance(from: text.startIndex, to: captured.lowerBound)
            let length = path.count + suffix.count
            let range = offset..<(offset + length)

            guard !path.isEmpty, isPlausibleFile(path) else { continue }
            guard !claimed.contains(where: { $0.overlaps(range) }) else { continue }

            found.append(
                Candidate(
                    path: path, line: lineNumber(from: suffix), offset: offset, length: length))
            claimed.append(range)
        }
    }

    private static func trimTrailing(_ path: String) -> String {
        var out = path
        while let last = out.unicodeScalars.last, trailingPunctuation.contains(last) {
            out.unicodeScalars.removeLast()
        }
        return out
    }

    private static func lineNumber(from suffix: String) -> Int? {
        guard suffix.hasPrefix(":") else { return nil }
        let digits = suffix.dropFirst().prefix { $0.isNumber }
        return digits.isEmpty ? nil : Int(digits)
    }

    /// Reject a candidate that is really a version, a decimal, a domain, or a
    /// word that ended a sentence.
    static func isPlausibleFile(_ path: String) -> Bool {
        // A path segment means someone typed a path — evidence enough on its
        // own, so the word/version filters below only police bare names.
        let hasDirectory = path.contains("/")
        let base = path.contains("/") ? String(path[path.index(after: path.lastIndex(of: "/")!)...]) : path

        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else {
            return hasDirectory || extensionlessFilenames.contains(base)
        }
        let stem = String(base[base.startIndex..<dot])
        let ext = String(base[base.index(after: dot)...]).lowercased()

        if ext.isEmpty { return false }
        // `1.2.3`, `3.14`, `v2.0` — an all-digit extension is a number.
        if ext.allSatisfy(\.isNumber) { return false }
        // A stem of nothing but digits/dots is a version string.
        if !hasDirectory, !stem.isEmpty, stem.allSatisfy({ $0.isNumber || $0 == "." }) { return false }

        if hasDirectory { return true }
        if wordyExtensions.contains(ext) { return false }
        if tldLike.contains(ext) { return false }
        if base.contains("..") { return false }
        return true
    }
}
