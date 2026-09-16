import CoreGraphics
import Foundation
import UIKit

enum MarkdownTableLayout {

    static let minimumCellWidth: CGFloat = 56

    static let maximumCellWidth: CGFloat = 260

    static let cellHorizontalPadding: CGFloat = 11
    static let cellVerticalPadding: CGFloat = 6

    static let bodyFontSize: CGFloat = 13
    static let codeFontSize: CGFloat = 14

    static func columnWidths(
        for table: MarkdownTable,
        measuring: (_ markdown: String, _ isHeader: Bool) -> CGFloat
    ) -> [CGFloat] {
        let columns = max(table.columnCount, 1)
        return (0..<columns).map { column in
            var widest: CGFloat = 0
            if column < table.header.count {
                widest = max(widest, measuring(table.header[column], true))
            }
            for row in table.rows where column < row.count {
                widest = max(widest, measuring(row[column], false))
            }
            let padded = widest + cellHorizontalPadding * 2
            return min(max(padded, minimumCellWidth), maximumCellWidth)
        }
    }

    static func columnWidths(for table: MarkdownTable) -> [CGFloat] {
        let key = cacheKey(for: table) as NSString
        if let hit = cache.object(forKey: key) { return hit.widths }
        let widths = columnWidths(for: table, measuring: textWidth)
        cache.setObject(CachedWidths(widths), forKey: key)
        return widths
    }

    static func totalWidth(for table: MarkdownTable) -> CGFloat {
        columnWidths(for: table).reduce(0, +)
    }

    static func textWidth(_ markdown: String, isHeader: Bool) -> CGFloat {
        let base = UIFont.systemFont(
            ofSize: bodyFontSize, weight: isHeader ? .semibold : .regular)
        guard
            let attributed = try? AttributedString(
                markdown: markdown,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        else {
            return ceil(width(of: markdown, font: base))
        }
        var total: CGFloat = 0
        for run in attributed.runs {
            let text = String(attributed[run.range].characters)
            total += width(of: text, font: font(for: run.inlinePresentationIntent, base: base))
        }
        return ceil(total)
    }

    private static func font(
        for intent: InlinePresentationIntent?, base: UIFont
    ) -> UIFont {
        guard let intent else { return base }
        if intent.contains(.code) {
            return .monospacedSystemFont(ofSize: codeFontSize, weight: .regular)
        }
        if intent.contains(.stronglyEmphasized) {
            return UIFont.systemFont(ofSize: bodyFontSize, weight: .bold)
        }
        return base
    }

    private static func width(of text: String, font: UIFont) -> CGFloat {
        (text as NSString).size(withAttributes: [.font: font]).width
    }

    private static func cacheKey(for table: MarkdownTable) -> String {
        ([table.header] + table.rows)
            .map { $0.joined(separator: "\u{1F}") }
            .joined(separator: "\u{1E}")
    }

    private final class CachedWidths {
        let widths: [CGFloat]
        init(_ widths: [CGFloat]) { self.widths = widths }
    }

    private static let cache: NSCache<NSString, CachedWidths> = {
        let cache = NSCache<NSString, CachedWidths>()
        cache.countLimit = 256
        return cache
    }()
}
