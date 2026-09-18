import Foundation






















enum FileMentions {

    
    
    
    
    
    
    struct Candidate: Equatable {
        
        let path: String
        
        let line: Int?
        
        let offset: Int
        
        let length: Int

        var range: Range<Int> { offset..<(offset + length) }
    }

    
    
    
    private static let wordyExtensions: Set<String> = [
        "so", "in", "at", "is", "it", "as", "be", "do", "go", "me", "my", "no",
        "of", "on", "or", "to", "up", "us", "we", "am", "an", "by", "if", "ok",
    ]

    
    
    
    private static let tldLike: Set<String> = [
        "com", "org", "net", "io", "dev", "ai", "app", "co", "gov", "edu",
        "ly", "tv", "xyz", "cloud", "computer", "software",
    ]

    
    
    private static let extensionlessFilenames: [String] = [
        "Makefile", "Dockerfile", "Justfile", "Rakefile", "Gemfile", "Procfile",
        "Brewfile", "Vagrantfile", "CODEOWNERS", "LICENSE", "README", "CHANGELOG",
        "AGENTS",
    ]

    
    
    
    
    
    
    
    
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

    
    
    
    
    
    
    static let maximumCandidates = 16

    
    
    
    
    private static let urlRegex: NSRegularExpression? = {
        try? NSRegularExpression(pattern: #"\b[a-z][a-z0-9+.-]*://\S+"#, options: [.caseInsensitive])
    }()

    
    
    
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

    
    
    static func isPlausibleFile(_ path: String) -> Bool {
        
        
        let hasDirectory = path.contains("/")
        let base = path.contains("/") ? String(path[path.index(after: path.lastIndex(of: "/")!)...]) : path

        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else {
            return hasDirectory || extensionlessFilenames.contains(base)
        }
        let stem = String(base[base.startIndex..<dot])
        let ext = String(base[base.index(after: dot)...]).lowercased()

        if ext.isEmpty { return false }
        
        if ext.allSatisfy(\.isNumber) { return false }
        
        if !hasDirectory, !stem.isEmpty, stem.allSatisfy({ $0.isNumber || $0 == "." }) { return false }

        if hasDirectory { return true }
        if wordyExtensions.contains(ext) { return false }
        if tldLike.contains(ext) { return false }
        if base.contains("..") { return false }
        return true
    }
}
