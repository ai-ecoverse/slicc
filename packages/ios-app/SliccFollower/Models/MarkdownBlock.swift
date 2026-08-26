import Foundation

// MARK: - Block model

/// One rendered block of leader markdown. `MarkdownText` owns the SwiftUI
/// side; the split keeps the block grammar unit-testable without a view
/// host (same reason `DockModel` is a pure builder).
enum MarkdownBlock: Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case blockquote(String)
    case codeBlock(language: String?, code: String)
    case list(MarkdownList)
    case table(MarkdownTable)
    case thematicBreak
}

/// A bullet or ordered list. Loose nesting only: every item carries its own
/// depth rather than owning children, which is enough for the flat
/// indent-and-marker rendering the transcript needs and avoids a recursive
/// parse the leader's output never exercises.
struct MarkdownList: Equatable {
    struct Item: Equatable {
        /// 0-based nesting level (two spaces or one tab per level).
        let depth: Int
        /// Rendered bullet/number, already resolved (`•`, `◦`, `1.`).
        let marker: String
        /// Inline markdown for the item body.
        let text: String
    }

    let ordered: Bool
    let items: [Item]
}

/// A GitHub-flavored pipe table.
struct MarkdownTable: Equatable {
    enum Alignment: Equatable {
        case leading
        case center
        case trailing
    }

    let header: [String]
    let alignments: [Alignment]
    let rows: [[String]]

    var columnCount: Int { header.count }
}

// MARK: - Parser

/// Block-level markdown grammar for the transcript.
///
/// `AttributedString(markdown:)` is inline-only in the configuration we use
/// (`.inlineOnlyPreservingWhitespace`), so every block construct has to be
/// recognised here or it reaches the screen as its literal source — which is
/// how comparison tables arrived as raw `| … | … |` rows.
enum MarkdownBlockParser {

    /// Memoized block grammar for a message body.
    ///
    /// `MarkdownText.blocks` is a computed property on a `View`, so it re-parses
    /// on **every body evaluation** — and the transcript re-evaluates its rows
    /// constantly (measured: 227 full re-parses just to scroll back two
    /// screens, on an 18-message fixture). Message bodies are immutable once a
    /// turn settles, so the same string parses to the same blocks forever;
    /// nothing but the streaming tail is ever a genuine miss.
    ///
    /// `NSCache` rather than a dictionary: it is thread-safe and evicts under
    /// memory pressure on its own, which matters because a streaming reply
    /// mints a new key per token and would otherwise grow without bound.
    private static let cache: NSCache<NSString, CachedBlocks> = {
        let cache = NSCache<NSString, CachedBlocks>()
        cache.countLimit = 256
        return cache
    }()

    /// Box, because `NSCache` holds objects and `[MarkdownBlock]` is a value.
    private final class CachedBlocks {
        let blocks: [MarkdownBlock]
        init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
    }

    /// Test seam: how many times the real parser actually ran. Only a cache
    /// MISS increments it, so a test can assert the memoization rather than
    /// just the output.
    #if DEBUG
        private(set) nonisolated(unsafe) static var parseCount = 0

        static func resetParseCountForTesting() {
            parseCount = 0
            cache.removeAllObjects()
        }
    #endif

    static func parse(_ content: String) -> [MarkdownBlock] {
        let key = content as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let blocks = parseUncached(content)
        cache.setObject(CachedBlocks(blocks), forKey: key)
        return blocks
    }

    private static func parseUncached(_ content: String) -> [MarkdownBlock] {
        #if DEBUG
            parseCount += 1
        #endif
        var blocks: [MarkdownBlock] = []
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        var paragraph: [String] = []
        var quote: [String] = []
        var listBuffer: [MarkdownList.Item] = []
        var listOrdered = false
        var index = 0

        func flushParagraph() {
            let joined = paragraph.joined(separator: "\n").trimmingCharacters(
                in: .whitespacesAndNewlines)
            if !joined.isEmpty { blocks.append(.paragraph(joined)) }
            paragraph = []
        }
        func flushQuote() {
            guard !quote.isEmpty else { return }
            let body = quote.map(stripQuoteMarker).joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty { blocks.append(.blockquote(body)) }
            quote = []
        }
        func flushList() {
            guard !listBuffer.isEmpty else { return }
            blocks.append(.list(MarkdownList(ordered: listOrdered, items: listBuffer)))
            listBuffer = []
        }
        func flushAll() {
            flushQuote()
            flushList()
            flushParagraph()
        }

        while index < lines.count {
            let line = lines[index]

            if isFence(line) {
                flushAll()
                let language = fenceLanguage(line)
                var code: [String] = []
                index += 1
                while index < lines.count, !isFence(lines[index]) {
                    code.append(lines[index])
                    index += 1
                }
                // An unclosed fence still renders as code — better than
                // spilling the rest of the turn as prose.
                blocks.append(.codeBlock(language: language, code: code.joined(separator: "\n")))
                index += 1
                continue
            }

            if isThematicBreak(line) {
                flushAll()
                blocks.append(.thematicBreak)
                index += 1
                continue
            }

            if let heading = parseAtxHeading(line) {
                flushAll()
                blocks.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            if let table = parseTable(lines, startingAt: index), table.consumed > 0 {
                flushAll()
                blocks.append(.table(table.table))
                index += table.consumed
                continue
            }

            if line.trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                flushList()
                flushParagraph()
                quote.append(line)
                index += 1
                continue
            }

            if let item = parseListItem(line) {
                flushQuote()
                flushParagraph()
                // A bullet list interrupting an ordered one (or vice versa)
                // is a new list, not a continuation.
                if !listBuffer.isEmpty && listOrdered != item.ordered { flushList() }
                listOrdered = item.ordered
                listBuffer.append(item.item)
                index += 1
                continue
            }

            flushQuote()
            if !listBuffer.isEmpty {
                // A blank line inside a list keeps the list open; anything
                // else ends it.
                if line.trimmingCharacters(in: .whitespaces).isEmpty {
                    index += 1
                    continue
                }
                flushList()
            }
            paragraph.append(line)
            index += 1
        }

        flushAll()
        return blocks
    }

    // MARK: - Fences

    private static func isFence(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("```")
    }

    /// The info string of an opening fence (```` ```swift ````), `nil` for a
    /// bare fence.
    private static func fenceLanguage(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        return language.isEmpty ? nil : language
    }

    // MARK: - Thematic break

    /// `---`, `***`, `___` (3+ of one marker, spaces allowed between). Must
    /// not swallow a table delimiter row, which always carries a pipe.
    static func isThematicBreak(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 3, !trimmed.contains("|") else { return false }
        guard let marker = trimmed.first, marker == "-" || marker == "*" || marker == "_" else {
            return false
        }
        var count = 0
        for char in trimmed {
            if char == marker {
                count += 1
            } else if char != " " {
                return false
            }
        }
        return count >= 3
    }

    // MARK: - Blockquote

    private static func stripQuoteMarker(_ line: String) -> String {
        var body = line.trimmingCharacters(in: .whitespaces)
        if body.hasPrefix(">") { body.removeFirst() }
        if body.hasPrefix(" ") { body.removeFirst() }
        return body
    }

    // MARK: - Lists

    /// `- item`, `* item`, `+ item`, `1. item`, `1) item`, with two spaces (or
    /// one tab) per nesting level.
    static func parseListItem(_ line: String) -> (item: MarkdownList.Item, ordered: Bool)? {
        var indent = 0
        var cursor = line.startIndex
        while cursor < line.endIndex, line[cursor] == " " || line[cursor] == "\t" {
            indent += line[cursor] == "\t" ? 4 : 1
            cursor = line.index(after: cursor)
        }
        guard cursor < line.endIndex else { return nil }
        let depth = min(indent / 2, 3)

        // Bullet: exactly one marker char followed by a space.
        if line[cursor] == "-" || line[cursor] == "*" || line[cursor] == "+" {
            let afterMarker = line.index(after: cursor)
            guard afterMarker < line.endIndex, line[afterMarker] == " " else { return nil }
            let body = String(line[line.index(after: afterMarker)...]).trimmingCharacters(
                in: .whitespaces)
            guard !body.isEmpty else { return nil }
            return (
                MarkdownList.Item(depth: depth, marker: bullet(for: depth), text: body),
                false
            )
        }

        // Ordered: up to 9 digits, then `.` or `)`, then a space.
        var digits = ""
        var scan = cursor
        while scan < line.endIndex, line[scan].isNumber, digits.count < 9 {
            digits.append(line[scan])
            scan = line.index(after: scan)
        }
        guard !digits.isEmpty, scan < line.endIndex, line[scan] == "." || line[scan] == ")" else {
            return nil
        }
        let afterDelimiter = line.index(after: scan)
        guard afterDelimiter < line.endIndex, line[afterDelimiter] == " " else { return nil }
        let body = String(line[line.index(after: afterDelimiter)...]).trimmingCharacters(
            in: .whitespaces)
        guard !body.isEmpty else { return nil }
        // The author's own numbering wins: a list that starts at 3 renders
        // as 3, matching every other markdown surface in the tray.
        return (
            MarkdownList.Item(depth: depth, marker: "\(digits).", text: body),
            true
        )
    }

    private static func bullet(for depth: Int) -> String {
        switch depth {
        case 0: return "•"
        case 1: return "◦"
        default: return "▪"
        }
    }

    // MARK: - Tables

    /// Parse a GFM pipe table starting at `start`. Returns `nil` when the two
    /// lines there are not a header + delimiter pair.
    static func parseTable(_ lines: [String], startingAt start: Int)
        -> (table: MarkdownTable, consumed: Int)?
    {
        guard start + 1 < lines.count else { return nil }
        let headerLine = lines[start]
        let delimiterLine = lines[start + 1]
        guard headerLine.contains("|"), let alignments = parseDelimiterRow(delimiterLine) else {
            return nil
        }
        let header = splitRow(headerLine)
        guard !header.isEmpty, header.count == alignments.count else { return nil }

        var rows: [[String]] = []
        var cursor = start + 2
        while cursor < lines.count {
            let line = lines[cursor]
            guard line.contains("|"), !line.trimmingCharacters(in: .whitespaces).isEmpty else {
                break
            }
            // A second delimiter row is not a body row.
            if parseDelimiterRow(line) != nil { break }
            var cells = splitRow(line)
            if cells.count < header.count {
                cells.append(contentsOf: Array(repeating: "", count: header.count - cells.count))
            } else if cells.count > header.count {
                cells = Array(cells.prefix(header.count))
            }
            rows.append(cells)
            cursor += 1
        }

        return (
            MarkdownTable(header: header, alignments: alignments, rows: rows),
            cursor - start
        )
    }

    /// `|---|:--:|---:|` → per-column alignment. `nil` when any cell is not a
    /// dash run, which is what separates a table from a paragraph of pipes.
    private static func parseDelimiterRow(_ line: String) -> [MarkdownTable.Alignment]? {
        guard line.contains("|"), line.contains("-") else { return nil }
        let cells = splitRow(line)
        guard !cells.isEmpty else { return nil }
        var alignments: [MarkdownTable.Alignment] = []
        for cell in cells {
            let trimmed = cell.trimmingCharacters(in: .whitespaces)
            let leadingColon = trimmed.hasPrefix(":")
            let trailingColon = trimmed.hasSuffix(":") && trimmed.count > 1
            var dashes = trimmed
            if leadingColon { dashes.removeFirst() }
            if trailingColon { dashes.removeLast() }
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            if leadingColon && trailingColon {
                alignments.append(.center)
            } else if trailingColon {
                alignments.append(.trailing)
            } else {
                alignments.append(.leading)
            }
        }
        return alignments
    }

    /// Split one table row into trimmed cells, honoring `\|` escapes and
    /// dropping the optional outer pipes.
    static func splitRow(_ line: String) -> [String] {
        var cells: [String] = []
        var current = ""
        var escaped = false
        for char in line.trimmingCharacters(in: .whitespaces) {
            if escaped {
                current.append(char == "|" ? "|" : "\\\(char)")
                escaped = false
                continue
            }
            if char == "\\" {
                escaped = true
                continue
            }
            if char == "|" {
                cells.append(current)
                current = ""
                continue
            }
            current.append(char)
        }
        if escaped { current.append("\\") }
        cells.append(current)
        // Outer pipes produce empty edge cells; a genuinely empty first or
        // last column would have been written as `| |`.
        if let first = cells.first, first.trimmingCharacters(in: .whitespaces).isEmpty {
            cells.removeFirst()
        }
        if let last = cells.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
            cells.removeLast()
        }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    // MARK: - Headings

    /// Parse a leading `# … ######` ATX heading. Returns nil for lines that
    /// aren't headings (so callers fall through to plain text).
    ///
    /// Follows CommonMark's ATX-heading rules:
    /// - 0-3 leading spaces are allowed (4+ → indented code block, not heading).
    /// - The opening `#` run must be followed by whitespace or end-of-line.
    /// - A trailing `#` run is only treated as a closing sequence when it's
    ///   preceded by whitespace; e.g. `# C#` keeps the `#` as part of the
    ///   title, while `# Heading ##` strips the closing `##`.
    static func parseAtxHeading(_ line: String) -> (level: Int, text: String)? {
        var leadingSpaces = 0
        var cursor = line.startIndex
        while cursor < line.endIndex, line[cursor] == " ", leadingSpaces < 4 {
            leadingSpaces += 1
            cursor = line.index(after: cursor)
        }
        guard leadingSpaces < 4 else { return nil }
        let trimmed = line[cursor...]
        guard trimmed.first == "#" else { return nil }
        var level = 0
        var index = trimmed.startIndex
        while index < trimmed.endIndex, trimmed[index] == "#", level < 6 {
            level += 1
            index = trimmed.index(after: index)
        }
        guard level >= 1 else { return nil }
        if index == trimmed.endIndex { return (level, "") }
        guard trimmed[index] == " " || trimmed[index] == "\t" else { return nil }
        let rawText = String(trimmed[index...])
        var endIndex = rawText.endIndex
        while endIndex > rawText.startIndex,
            rawText[rawText.index(before: endIndex)] == " "
                || rawText[rawText.index(before: endIndex)] == "\t"
        {
            endIndex = rawText.index(before: endIndex)
        }
        var hashStart = endIndex
        while hashStart > rawText.startIndex, rawText[rawText.index(before: hashStart)] == "#" {
            hashStart = rawText.index(before: hashStart)
        }
        let hadTrailingHashes = hashStart < endIndex
        let bodyEnd: String.Index
        if hadTrailingHashes,
            hashStart == rawText.startIndex
                || rawText[rawText.index(before: hashStart)] == " "
                || rawText[rawText.index(before: hashStart)] == "\t"
        {
            bodyEnd = hashStart
        } else {
            bodyEnd = endIndex
        }
        return (level, String(rawText[rawText.startIndex..<bodyEnd]).trimmingCharacters(in: .whitespaces))
    }
}
