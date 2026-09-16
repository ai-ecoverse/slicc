import SwiftUI

struct ToolUIPlaceholder: Identifiable, Equatable {

    let id: String
    let title: String

    static let fallbackTitle = "Approval requested"

    init(requestId: String, html: String) {
        self.id = requestId
        self.title = Self.extractTitle(from: html)
    }

    static func extractTitle(from html: String) -> String {
        guard let header = firstElementContent(in: html, className: "sprinkle-action-card__header")
        else { return fallbackTitle }
        let stripped = stripTags(removeNestedElements(from: header))
        let title = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? fallbackTitle : title
    }

    private static func firstElementContent(in html: String, className: String) -> String? {
        guard let classRange = html.range(of: "class=\"\(className)\"") else { return nil }
        guard let openStart = html.range(of: "<", options: .backwards, range: html.startIndex..<classRange.lowerBound)
        else { return nil }
        let tagName = html[html.index(after: openStart.lowerBound)...]
            .prefix { $0.isLetter || $0.isNumber }
        guard !tagName.isEmpty else { return nil }
        guard let openEnd = html.range(of: ">", range: classRange.upperBound..<html.endIndex)
        else { return nil }

        var depth = 1
        var cursor = openEnd.upperBound
        let contentStart = cursor
        while cursor < html.endIndex {
            guard let next = html.range(of: "<", range: cursor..<html.endIndex) else { break }
            let rest = html[next.upperBound...]
            if rest.hasPrefix("/\(tagName)") {
                depth -= 1
                if depth == 0 { return String(html[contentStart..<next.lowerBound]) }
            } else if rest.hasPrefix(tagName) {
                depth += 1
            }
            guard let close = html.range(of: ">", range: next.upperBound..<html.endIndex) else { break }
            cursor = close.upperBound
        }
        return nil
    }

    private static func removeNestedElements(from html: String) -> String {
        var result = html
        for className in ["sprinkle-badge", "sprinkle-action-card__meta"] {
            while let inner = firstElementContent(in: result, className: className),
                let range = result.range(of: inner)
            {

                guard
                    let openStart = result.range(
                        of: "<", options: .backwards, range: result.startIndex..<range.lowerBound),
                    let closeEnd = result.range(of: ">", range: range.upperBound..<result.endIndex)
                else { break }
                result.removeSubrange(openStart.lowerBound..<closeEnd.upperBound)
            }
        }
        return result
    }

    private static func stripTags(_ html: String) -> String {

        let withoutTags = html.replacingOccurrences(
            of: "<[^>]+>", with: "", options: .regularExpression)
        return
            withoutTags
            .replacingOccurrences(of: "&hellip;", with: "…")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }
}

struct ToolUICardView: View {
    let card: ToolUIPlaceholder

    @Environment(\.palette) private var palette

    private var cardBackground: Color { palette.surface }
    private let borderColor = Color.white.opacity(0.10)

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Text(card.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(palette.ink.opacity(0.85))
                Text("pending")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(palette.ink.opacity(0.75))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.white.opacity(0.12)))
            }
            Text("Waiting for approval on the leader…")
                .font(.system(size: 12.5))
                .foregroundStyle(palette.ink.opacity(0.6))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(borderColor, lineWidth: 0.5)
        )
        .padding(.horizontal, 4)
        .accessibilityIdentifier("tool-ui-\(card.id)")
    }
}
