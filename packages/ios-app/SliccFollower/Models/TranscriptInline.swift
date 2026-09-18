import Foundation
import SwiftUI
















enum TranscriptInline {

    
    
    
    static func parse(_ markdown: String) -> AttributedString {
        (try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(markdown)
    }

    
    
    static func fileQueries(in markdown: String) -> [String] {
        var seen = Set<String>()
        return FileMentions.scan(markdown).compactMap { candidate in
            seen.insert(candidate.path).inserted ? candidate.path : nil
        }
    }

    
    
    
    
    
    
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

        
        
        
        for (range, link) in spans.sorted(by: { $0.0.lowerBound > $1.0.lowerBound }) {
            guard let url = link.url,
                let target = attributedRange(in: output, offset: range.lowerBound, length: range.count)
            else { continue }
            
            
            guard !output[target].runs.contains(where: { $0.link != nil }) else { continue }
            output[target].link = url
        }
        return output
    }

    
    
    
    
    
    
    private static func annotateCode(_ attributed: inout AttributedString) {
        for run in attributed.runs {
            guard let intent = run.inlinePresentationIntent, intent.contains(.code) else { continue }
            guard run.link == nil else { continue }
            let text = String(attributed[run.range].characters)
            guard !text.isEmpty, let url = TranscriptLink.code(text).url else { continue }
            attributed[run.range].link = url
        }
    }

    
    
    
    static func attributedRange(in attributed: AttributedString, offset: Int, length: Int)
        -> Range<AttributedString.Index>?
    {
        
        
        guard offset >= 0, length > 0, offset + length <= attributed.characters.count else {
            return nil
        }
        let start = attributed.index(attributed.startIndex, offsetByCharacters: offset)
        let end = attributed.index(start, offsetByCharacters: length)
        return start..<end
    }
}















struct TranscriptParagraph {
    enum Segment {
        case text(AttributedString)
        case payload(Base64Payload)
    }

    let segments: [Segment]

    
    
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

    
    
    
    
    
    
    
    
    
    private static func appendText(_ value: AttributedString, to segments: inout [Segment]) {
        guard let trimmed = trimming(value) else { return }
        segments.append(.text(trimmed))
    }

    
    
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












final class TranscriptInlineCache: @unchecked Sendable {
    static let shared = TranscriptInlineCache()

    
    
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

    
    
    
    func clear() { store.removeAllObjects() }

    static func cacheKey(markdown: String, files: [String: String]) -> NSString {
        guard !files.isEmpty else { return markdown as NSString }
        let suffix = files.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: "\u{1F}")
        return "\(markdown)\u{1E}\(suffix)" as NSString
    }
}
