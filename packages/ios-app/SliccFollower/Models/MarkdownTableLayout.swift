import CoreGraphics
import Foundation
import UIKit

/// Column geometry for a rendered pipe table.
///
/// SwiftUI's `Grid` cannot express the web contract for
/// `slicc-agent-message .body table` on its own. Inside a horizontal
/// `ScrollView` the Grid is proposed the viewport width, which stretches a
/// three-column table across an iPad and squeezes its columns; pinning the
/// cells with `fixedSize` instead hugs the content but then a long cell
/// renders at its full single-line width and gets clipped by any cap. The
/// widths are therefore resolved up front — hug the widest cell, cap a
/// runaway column, and let the text wrap **inside** that cap.
///
/// The rule is a pure function of measured cell widths so it is testable
/// without a view; only `textWidth(_:isHeader:)` touches UIKit.
enum MarkdownTableLayout {
    /// Cell width floor, so a `yes` / `no` column still reads as a column.
    static let minimumCellWidth: CGFloat = 56
    /// Cell width ceiling. Past this a cell wraps rather than widening the
    /// table further — the web's `max-width: 100%` in fixed form.
    static let maximumCellWidth: CGFloat = 260
    /// Mirrors the web's `padding: 6px 11px` on `th`/`td`.
    static let cellHorizontalPadding: CGFloat = 11
    static let cellVerticalPadding: CGFloat = 6
    /// Mirrors the web's `font-size: 13px`; inline code renders one point
    /// larger in the monospace face (`styledInlineCode`).
    static let bodyFontSize: CGFloat = 13
    static let codeFontSize: CGFloat = 14

    /// Resolved width of every column, padding included.
    ///
    /// `measuring` receives the raw markdown of a cell and whether it is a
    /// header cell, and returns the width its rendered text wants on one
    /// line. Injected so tests can drive the rule with exact numbers.
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

    /// Memoized `columnWidths(for:measuring:)` over the live text measurer.
    ///
    /// `MarkdownText` re-evaluates its body constantly while the transcript
    /// scrolls (see `MarkdownBlockParser.cache`), and laying out every cell
    /// with Core Text on each pass is far more expensive than the block
    /// parse it already memoizes. Same `NSCache` reasoning: thread-safe and
    /// self-evicting, which a streaming table needs.
    static func columnWidths(for table: MarkdownTable) -> [CGFloat] {
        let key = cacheKey(for: table) as NSString
        if let hit = cache.object(forKey: key) { return hit.widths }
        let widths = columnWidths(for: table, measuring: textWidth)
        cache.setObject(CachedWidths(widths), forKey: key)
        return widths
    }

    /// Width of the whole card: the sum of its column widths.
    ///
    /// This is also what the table's scroll guard is capped to, so the
    /// guard's gesture region never claims the blank space beside a hugged
    /// card — space where, on iOS 18+, a scoop swipe would be dropped
    /// (`SwipeArbiter.outerAction` defers guarded origins to an inner
    /// recognizer that only covers the content).
    static func totalWidth(for table: MarkdownTable) -> CGFloat {
        columnWidths(for: table).reduce(0, +)
    }

    /// Single-line width of one cell's rendered text.
    ///
    /// Measured run by run off the same inline parse the view renders, so a
    /// `code` chip is measured in the monospace face it actually paints in
    /// and a **bold** span in its heavier one. Measuring the raw source
    /// instead would size a column to its markdown syntax.
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

    /// Cell contents alone decide the widths, so they alone key the cache.
    /// The separators are control characters no markdown cell can contain.
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
