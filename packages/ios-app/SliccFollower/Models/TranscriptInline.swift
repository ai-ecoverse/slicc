import Foundation
import SwiftUI

// MARK: - Inline entity annotation

/// The one place a run of inline markdown becomes ACTIONABLE.
///
/// `MarkdownText` parses inline spans with `AttributedString(markdown:)`; this
/// takes that result and marks the spans a reader can do something with — a
/// confirmed file, a phone number, a run of pre-formatted code — by giving
/// each one a `TranscriptLink` URL. Painting and gestures live in the views
/// (`TranscriptText` for the UIKit text view that carries the long-press
/// menus, plain SwiftUI `Text` for headings and table cells).
///
/// Annotation happens on the RENDERED characters, never on the markdown
/// source. `[the plan](https://x)` renders as `the plan`, and scanning the
/// source would run a phone-number span across a URL's digits or a file span
/// across a link target. What the reader sees is what gets scanned.
enum TranscriptInline {

    /// Parse `markdown` the way the transcript does. Inline only: block syntax
    /// is `MarkdownBlockParser`'s job, and enabling it here would turn a
    /// line-leading `#` inside a paragraph into a heading.
    static func parse(_ markdown: String) -> AttributedString {
        (try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(markdown)
    }

    /// The file mentions in a raw markdown run, used to decide what to ask the
    /// leader about before anything is painted.
    static func fileQueries(in markdown: String) -> [String] {
        var seen = Set<String>()
        return FileMentions.scan(markdown).compactMap { candidate in
            seen.insert(candidate.path).inserted ? candidate.path : nil
        }
    }

    /// Annotate a parsed run.
    ///
    /// `files` maps the text that was WRITTEN to the leader path that was
    /// confirmed. A mention absent from the map stays plain text — the
    /// resolver either has not answered yet or answered "no", and to a reader
    /// both mean the same thing: nothing to tap.
    static func annotate(_ attributed: AttributedString, files: [String: String] = [:])
        -> AttributedString
    {
        var output = attributed
        annotateCode(&output)

        let text = String(output.characters)
        guard !text.isEmpty else { return output }

        var spans: [(Range<Int>, TranscriptLink)] = []
        for candidate in FileMentions.scan(text) {
            guard let path = files[candidate.path] else { continue }
            spans.append((candidate.range, .file(path: path, line: candidate.line)))
        }
        for candidate in PhoneMentions.scan(text) {
            spans.append((candidate.range, .phone(candidate.number)))
        }

        // Applied back-to-front. Attaching a link never changes the character
        // count, but working in reverse keeps the index arithmetic obviously
        // independent of anything applied before it.
        for (range, link) in spans.sorted(by: { $0.0.lowerBound > $1.0.lowerBound }) {
            guard let url = link.url,
                let target = attributedRange(in: output, offset: range.lowerBound, length: range.count)
            else { continue }
            // A markdown link's own label is the author's choice of
            // destination; a second link layered over it would silently win.
            guard !output[target].runs.contains(where: { $0.link != nil }) else { continue }
            output[target].link = url
        }
        return output
    }

    /// Give every inline `code` run its own action link.
    ///
    /// Pre-formatted text is what a reader most often wants OUT of a
    /// transcript — a command to run, an id to paste — and on a phone there is
    /// no cursor to drag across four characters of monospace. A tap opens
    /// Copy/Share instead. Runs already inside a link are left alone.
    private static func annotateCode(_ attributed: inout AttributedString) {
        for run in attributed.runs {
            guard let intent = run.inlinePresentationIntent, intent.contains(.code) else { continue }
            guard run.link == nil else { continue }
            let text = String(attributed[run.range].characters)
            guard !text.isEmpty, let url = TranscriptLink.code(text).url else { continue }
            attributed[run.range].link = url
        }
    }

    /// Map a character offset onto an `AttributedString` range. The bridge is
    /// a CHARACTER offset, not a UTF-8 one, which an emoji in the sentence
    /// would misalign.
    static func attributedRange(in attributed: AttributedString, offset: Int, length: Int)
        -> Range<AttributedString.Index>?
    {
        // `AttributedString.index(_:offsetByCharacters:)` traps past the end
        // rather than returning nil, so the bounds are checked here.
        guard offset >= 0, length > 0, offset + length <= attributed.characters.count else {
            return nil
        }
        let start = attributed.index(attributed.startIndex, offsetByCharacters: offset)
        let end = attributed.index(start, offsetByCharacters: length)
        return start..<end
    }
}

// MARK: - Paragraph plan

/// One inline run, ready to paint — text, and the base64 blobs elided out of
/// it.
///
/// The elision mirrors the web's `ui/base64-preview-linker.ts`: a payload is
/// swapped for a chip only once its bytes DECODE and are recognisable, because
/// collapsing a run hides text the user wrote. Everything unrecognised stays
/// exactly as it was typed.
///
/// Unlike the web, a chip is not inline. SwiftUI has no way to seat a button
/// inside a `Text`, so a paragraph carrying a payload is split into stacked
/// segments. That reads fine in practice: a blob big enough to clear the
/// 128-character bar is never mid-sentence in a way that matters.
struct TranscriptParagraph {
    enum Segment {
        case text(AttributedString)
        case payload(Base64Payload)
    }

    let segments: [Segment]

    /// The whole run as one attributed string, for the call sites that cannot
    /// stack (headings, table cells).
    let attributed: AttributedString

    static func build(markdown: String, files: [String: String]) -> TranscriptParagraph {
        let attributed = TranscriptInline.annotate(
            TranscriptInline.parse(markdown), files: files)
        let text = String(attributed.characters)

        var confirmed: [(Range<Int>, Base64Payload)] = []
        for candidate in Base64Mentions.scan(text) {
            guard let payload = Base64Payload.identify(candidate.data, declaredMime: candidate.declaredMime)
            else { continue }
            let offset = text.distance(from: text.startIndex, to: candidate.range.lowerBound)
            let length = text.distance(from: candidate.range.lowerBound, to: candidate.range.upperBound)
            confirmed.append((offset..<(offset + length), payload))
        }
        guard !confirmed.isEmpty else {
            return TranscriptParagraph(segments: [.text(attributed)], attributed: attributed)
        }

        var segments: [Segment] = []
        var cursor = 0
        for (range, payload) in confirmed.sorted(by: { $0.0.lowerBound < $1.0.lowerBound }) {
            if range.lowerBound > cursor,
                let head = TranscriptInline.attributedRange(
                    in: attributed, offset: cursor, length: range.lowerBound - cursor)
            {
                appendText(AttributedString(attributed[head]), to: &segments)
            }
            segments.append(.payload(payload))
            cursor = range.upperBound
        }
        let tail = attributed.characters.count - cursor
        if tail > 0,
            let rest = TranscriptInline.attributedRange(
                in: attributed, offset: cursor, length: tail)
        {
            appendText(AttributedString(attributed[rest]), to: &segments)
        }
        return TranscriptParagraph(segments: segments, attributed: attributed)
    }

    /// Append a text segment with the whitespace a lifted payload left behind
    /// trimmed off both ends.
    ///
    /// A paragraph block can legitimately contain blank lines — the parser
    /// flushes on a fence, a heading or a list, not on an empty line — so the
    /// text either side of a blob is typically `…generated:\n\n` and
    /// `\n\nAnd the note…`. Painted as-is those blank lines survive the
    /// elision as a hole above and below the chip, which is exactly the noise
    /// the chip exists to remove.
    private static func appendText(_ value: AttributedString, to segments: inout [Segment]) {
        guard let trimmed = trimming(value) else { return }
        segments.append(.text(trimmed))
    }

    /// `AttributedString` has no `trimmingCharacters`; walking the character
    /// view is the supported way to narrow one without dropping its runs.
    static func trimming(_ value: AttributedString) -> AttributedString? {
        let characters = value.characters
        var start = characters.startIndex
        var end = characters.endIndex
        while start < end, characters[start].isWhitespace {
            start = characters.index(after: start)
        }
        while end > start, characters[characters.index(before: end)].isWhitespace {
            end = characters.index(before: end)
        }
        guard start < end else { return nil }
        return AttributedString(value[start..<end])
    }
}

// MARK: - Memoisation

/// A small cache in front of the inline pipeline.
///
/// `MarkdownText` rebuilds its content on every body evaluation — measured at
/// 871 evaluations to scroll back two screens over 18 messages — and this
/// pipeline adds a markdown parse, two regex passes, an `NSDataDetector` walk
/// and (for anything long enough) a base64 decode on top. Keying the finished
/// paragraph by (markdown, confirmed files) makes a scroll free while keeping
/// the newly-resolved case correct: when a mention resolves, the key changes
/// and the run is rebuilt.
final class TranscriptInlineCache: @unchecked Sendable {
    static let shared = TranscriptInlineCache()

    /// `NSCache` evicts under memory pressure, which is the right policy for
    /// something that is pure recomputation.
    private let store = NSCache<NSString, Box>()

    private final class Box {
        let value: TranscriptParagraph
        init(_ value: TranscriptParagraph) { self.value = value }
    }

    private init() { store.countLimit = 512 }

    func paragraph(markdown: String, files: [String: String]) -> TranscriptParagraph {
        let key = Self.cacheKey(markdown: markdown, files: files)
        if let hit = store.object(forKey: key) { return hit.value }
        let value = TranscriptParagraph.build(markdown: markdown, files: files)
        store.setObject(Box(value), forKey: key)
        return value
    }

    /// Drop everything. Called when the follower detaches: a new leader has a
    /// different filesystem, and a cached confirmation would paint a link to a
    /// file that is not there.
    func clear() { store.removeAllObjects() }

    static func cacheKey(markdown: String, files: [String: String]) -> NSString {
        guard !files.isEmpty else { return markdown as NSString }
        let suffix = files.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: "\u{1F}")
        return "\(markdown)\u{1E}\(suffix)" as NSString
    }
}
