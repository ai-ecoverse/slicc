import Foundation

enum Base64Mentions {

    struct Candidate: Equatable {

        let data: String

        let declaredMime: String?

        let range: Range<String.Index>
    }

    static let minimumPayloadCharacters = 128

    private static let minimumWrapColumns = 16

    private static let dataURLRegex: NSRegularExpression? = {
        try? NSRegularExpression(
            pattern: #"data:([\w.+-]+/[\w.+-]+)(?:;[\w.+-]+=[^;,]*)*;base64,([A-Za-z0-9+/=]+)"#)
    }()

    private static let bareRunRegex: NSRegularExpression? = {
        let openers = #"\s"'`(\[{<,;:="#
        let closers = #"\s"'`)\]}>,;:.!?"#
        return try? NSRegularExpression(
            pattern:
                "(?:^|[\(openers)])([A-Za-z0-9+/]{\(minimumPayloadCharacters),}={0,2})(?=$|[\(closers)])"
        )
    }()

    static func scan(_ text: String) -> [Candidate] {
        guard text.count >= minimumPayloadCharacters else { return [] }
        var found: [Candidate] = []
        var claimed: [Range<String.Index>] = []

        if let regex = dataURLRegex {
            for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let whole = Range(match.range, in: text),
                    let payloadRange = Range(match.range(at: 2), in: text),
                    let mimeRange = Range(match.range(at: 1), in: text)
                else { continue }
                let payload = String(text[payloadRange])
                guard payload.count >= minimumPayloadCharacters,
                    let data = normalized(payload)
                else { continue }
                found.append(
                    Candidate(data: data, declaredMime: String(text[mimeRange]), range: whole))
                claimed.append(whole)
            }
        }

        for block in wrappedBlocks(in: text) where !claimed.contains(where: { $0.overlaps(block.range) }) {
            found.append(block)
            claimed.append(block.range)
        }

        if let regex = bareRunRegex {
            for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let run = Range(match.range(at: 1), in: text) else { continue }
                if claimed.contains(where: { $0.overlaps(run) }) { continue }
                let raw = String(text[run])

                guard raw.count % 4 == 0, let data = normalized(raw) else { continue }
                found.append(Candidate(data: data, declaredMime: nil, range: run))
                claimed.append(run)
            }
        }

        found.sort { $0.range.lowerBound < $1.range.lowerBound }
        return found
    }

    private struct SourceLine {
        let range: Range<String.Index>
        let text: Substring
    }

    private static func wrappedBlocks(in text: String) -> [Candidate] {
        let lines = scanLines(text)
        var blocks: [Candidate] = []
        var index = 0
        while index < lines.count {
            guard let width = wrapWidth(lines, at: index) else {
                index += 1
                continue
            }
            let tail = blockEnd(lines, from: index, width: width)
            if tail == index {
                index += 1
                continue
            }
            var pieces = Array(lines[index...tail])
            if let lead = precedingFragment(lines, at: index, width: width) {
                pieces.insert(lead, at: 0)
            }
            if let block = claim(pieces) { blocks.append(block) }
            index = tail + 1
        }
        return blocks
    }

    private static func scanLines(_ text: String) -> [SourceLine] {
        var lines: [SourceLine] = []
        var start = text.startIndex
        while true {
            let brk = text[start...].firstIndex(of: "\n")
            let end = brk ?? text.endIndex

            var trimmed = end
            if trimmed > start, text[text.index(before: trimmed)] == "\r" {
                trimmed = text.index(before: trimmed)
            }
            lines.append(SourceLine(range: start..<trimmed, text: text[start..<trimmed]))
            guard let brk else { return lines }
            start = text.index(after: brk)
        }
    }

    private static func isPureAlphabet(_ s: Substring) -> Bool {
        !s.isEmpty && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/") }
    }

    private static func isPaddedTail(_ s: Substring) -> Bool {
        let padding = s.drop(while: { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/") })
        return s.count > padding.count && padding.count <= 2 && padding.allSatisfy { $0 == "=" }
    }

    private static func wrapWidth(_ lines: [SourceLine], at index: Int) -> Int? {
        let first = lines[index]
        let width = first.text.count
        guard width >= minimumWrapColumns, width % 4 == 0, isPureAlphabet(first.text) else {
            return nil
        }
        return width
    }

    private static func blockEnd(_ lines: [SourceLine], from index: Int, width: Int) -> Int {
        var last = index
        var j = index + 1
        while j < lines.count, lines[j].text.count == width, isPureAlphabet(lines[j].text) {
            last = j
            j += 1
        }
        guard last + 1 < lines.count else { return last }
        let next = lines[last + 1].text
        guard !next.isEmpty, next.count < width, isPaddedTail(next) else { return last }
        if last + 2 < lines.count, lines[last + 2].text.count == width,
            isPureAlphabet(lines[last + 2].text)
        {
            return last
        }
        return last + 1
    }

    private static func precedingFragment(_ lines: [SourceLine], at index: Int, width: Int)
        -> SourceLine?
    {
        guard index > 0 else { return nil }
        let prev = lines[index - 1]
        guard prev.text.count > width else { return nil }
        let cut = prev.text.index(prev.text.endIndex, offsetBy: -width)
        let suffix = prev.text[cut...]
        guard isPureAlphabet(suffix) else { return nil }
        let before = prev.text[prev.text.index(before: cut)]
        guard !isPureAlphabet(Substring(String(before))) else { return nil }
        return SourceLine(range: cut..<prev.range.upperBound, text: suffix)
    }

    private static func claim(_ block: [SourceLine]) -> Candidate? {
        let joined = block.map { String($0.text) }.joined()
        let unpadded = joined.reversed().drop(while: { $0 == "=" }).count
        guard unpadded >= minimumPayloadCharacters, joined.count % 4 == 0,
            let data = normalized(joined),
            let start = block.first?.range.lowerBound, let end = block.last?.range.upperBound
        else { return nil }
        return Candidate(data: data, declaredMime: nil, range: start..<end)
    }

    static func normalized(_ raw: String) -> String? {
        let stripped = raw.filter { !$0.isWhitespace }
        guard !stripped.isEmpty else { return nil }
        let body = stripped.prefix { $0 != "=" }
        guard body.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/") })
        else { return nil }
        let pad = stripped.dropFirst(body.count)
        guard pad.allSatisfy({ $0 == "=" }), pad.count <= 2 else { return nil }
        let remainder = body.count % 4
        if remainder == 1 { return nil }
        return remainder == 0 ? String(body) : String(body) + String(repeating: "=", count: 4 - remainder)
    }
}
