import Foundation

// MARK: - Base64 mentions

/// Finding base64 payloads in chat text — the Swift mirror of the web's
/// `core/base64-mentions.ts`.
///
/// People paste blobs into chat: a screenshot as a data URL, the output of
/// `base64 < key.pem`, an API response with an embedded attachment. Rendered
/// as prose, one of those is thousands of unbroken characters that bury the
/// sentence around them under forty lines of noise.
///
/// This module extracts CANDIDATES only. Whether a candidate is really a
/// payload comes from DECODING it and looking at the bytes
/// (`Base64Payload.identify`). The split mirrors `FileMentions`, but the
/// failure costs are sharper: a wrong file mention is a link that goes
/// nowhere, whereas a wrong base64 match ELIDES text the user typed. So this
/// heuristic is the conservative twin — long, well-formed, whole-token — and
/// the caller still has to recognise the bytes.
enum Base64Mentions {

    /// A base64 payload found in text, with the span it occupies.
    struct Candidate: Equatable {
        /// The payload, whitespace stripped and padding restored.
        let data: String
        /// The MIME type a `data:` URL declared, when the candidate was one.
        let declaredMime: String?
        /// Range in the source string.
        let range: Range<String.Index>
    }

    /// How many alphabet characters a bare run needs before it counts.
    ///
    /// 128 characters is 96 decoded bytes — enough for magic bytes or a
    /// legible line of text, and above the common false-positive sizes (a
    /// sha256 hex digest is 64, a UUID shorter still).
    static let minimumPayloadCharacters = 128

    /// The narrowest wrap column a block is believed at. The widths that
    /// occur are 64 (PEM), 72 and 76 (`base64`(1) and MIME).
    private static let minimumWrapColumns = 16

    private static let dataURLRegex: NSRegularExpression? = {
        try? NSRegularExpression(
            pattern: #"data:([\w.+-]+/[\w.+-]+)(?:;[\w.+-]+=[^;,]*)*;base64,([A-Za-z0-9+/=]+)"#)
    }()

    /// A bare run: an opening boundary, the alphabet, and up to two pads.
    ///
    /// `.` opens nothing (it would claim the middle segment of a JWT) but it
    /// CLOSES a run, because a payload at the end of a sentence is followed by
    /// a period. `-`/`_` bound base64url slices, which cannot decode anyway.
    private static let bareRunRegex: NSRegularExpression? = {
        let openers = #"\s"'`(\[{<,;:="#
        let closers = #"\s"'`)\]}>,;:.!?"#
        return try? NSRegularExpression(
            pattern:
                "(?:^|[\(openers)])([A-Za-z0-9+/]{\(minimumPayloadCharacters),}={0,2})(?=$|[\(closers)])"
        )
    }()

    /// Extract every plausible payload from `text`, in order and without
    /// overlaps. Most-specific first: `data:` URLs (which carry a declared
    /// type), then column-wrapped blocks, then bare single-line runs — a wide
    /// wrap column can clear the bare-run bar on its own, so the block has to
    /// claim its lines first.
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
                // A whole number of quanta. A real encoder emits the padding;
                // an unpadded remainder means this run is a slice of something.
                guard raw.count % 4 == 0, let data = normalized(raw) else { continue }
                found.append(Candidate(data: data, declaredMime: nil, range: run))
                claimed.append(run)
            }
        }

        found.sort { $0.range.lowerBound < $1.range.lowerBound }
        return found
    }

    // MARK: - Wrapped blocks

    private struct SourceLine {
        let range: Range<String.Index>
        let text: Substring
    }

    /// Column-wrapped base64: what `base64`(1) writes by default.
    ///
    /// Reassembly is deliberately narrow, because gluing lines together is
    /// where a heuristic starts eating prose. A block is believed only when it
    /// has the exact shape an encoder produces: two or more whole lines, every
    /// line but the last pure alphabet of the SAME quantum-aligned width, and
    /// only the last one allowed to carry padding. A stanza of English fails
    /// on the second rule almost immediately.
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
                index += 1  // a single line is the bare-run pattern's job
                continue
            }
            var pieces = Array(lines[index...tail])
            if let lead = precedingFragment(lines, at: index, width: width) {
                pieces.insert(lead, at: 0)
            }
            if let block = claim(pieces) { blocks.append(block) }
            index = tail + 1  // never re-enter a block we already walked
        }
        return blocks
    }

    private static func scanLines(_ text: String) -> [SourceLine] {
        var lines: [SourceLine] = []
        var start = text.startIndex
        while true {
            let brk = text[start...].firstIndex(of: "\n")
            let end = brk ?? text.endIndex
            // A CRLF paste puts the `\r` inside the line; it is a separator.
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

    /// `^[A-Za-z0-9+/]+={0,2}$` — a block's final, shorter line.
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

    /// Index of the last line of the block starting at `index`: every
    /// following line of exactly `width`, then optionally one narrower final
    /// line — but only if nothing MORE of the block follows it, or a ragged
    /// pair of prose lines (76 then 72) would read as a complete block.
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

    /// The tail of the line BEFORE a block, when the payload plainly started
    /// there: `here it is: <76 chars>` followed by more full-width lines is
    /// one paste with the user's words in front of it. Without this the block
    /// is claimed from its SECOND line, stranding the first 76 characters
    /// beside the chip.
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

    // MARK: - Normalisation

    /// Strip whitespace and restore padding, or `nil` when the run is not a
    /// decodable base64 body.
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
