import SwiftUI

// MARK: - MarkdownText

/// Renders markdown content as styled SwiftUI views.
///
/// The block grammar lives in `MarkdownBlockParser`; this view only paints
/// it. `AttributedString(markdown:)` is used for inline spans only — it
/// cannot render fenced code, tables or lists, which is why those are
/// recognised as blocks first.
struct MarkdownText: View {
    @Environment(\.palette) private var palette

    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text):
                    markdownTextView(text)
                case .heading(let level, let text):
                    headingView(level: level, text: text)
                case .blockquote(let text):
                    blockquoteView(text: text)
                case .codeBlock(let lang, let code):
                    codeBlockView(language: lang, code: code)
                case .list(let list):
                    listView(list)
                case .table(let table):
                    tableView(table)
                case .thematicBreak:
                    Rectangle()
                        .fill(palette.line)
                        .frame(height: 1)
                        .padding(.vertical, 2)
                }
            }
        }
    }

    private var blocks: [MarkdownBlock] { MarkdownBlockParser.parse(content) }

    // MARK: - Inline Text Rendering

    /// The one place inline markdown is parsed. Everything block-level hands
    /// its body through here so **bold**, `code` and links behave the same
    /// in a paragraph, a heading, a list item and a table cell.
    private func inlineText(_ text: String) -> Text {
        guard
            let attributed = try? AttributedString(
                markdown: text,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        else {
            return Text(text)
        }
        return Text(styledForInlineCode(attributed))
    }

    @ViewBuilder
    private func markdownTextView(_ text: String) -> some View {
        inlineText(text)
            .font(.system(size: 15))
            .foregroundStyle(palette.ink.opacity(0.9))
            .tint(palette.accent)
    }

    /// Apply the assistant-bubble inline-code style: white@10 background,
    /// lavender foreground, 14pt monospace. Wrapper around the shared
    /// `styledInlineCode(...)` helper so the assistant call sites stay
    /// terse.
    private func styledForInlineCode(_ input: AttributedString) -> AttributedString {
        return styledInlineCode(
            input,
            background: palette.ink.opacity(0.10),
            foreground: palette.accent
        )
    }

    // MARK: - Heading Rendering

    /// ATX heading. Levels 1-6 map onto a decreasing type scale; the bottom
    /// margin/spacing is owned by the parent VStack.
    @ViewBuilder
    private func headingView(level: Int, text: String) -> some View {
        let size: CGFloat = {
            switch level {
            case 1: return 22
            case 2: return 19
            case 3: return 17
            case 4: return 15
            default: return 14
            }
        }()
        let weight: Font.Weight = level <= 2 ? .bold : .semibold
        inlineText(text)
            .font(.system(size: size, weight: weight))
            .foregroundStyle(palette.ink)
    }

    // MARK: - Blockquote Rendering

    /// Blockquote: faint left bar + secondary text color. The body itself
    /// is rendered through the same inline parser so nested **bold**,
    /// `code`, links, etc. still work.
    private func blockquoteView(text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(palette.ink.opacity(0.20))
                .frame(width: 3)
            inlineText(text)
                .font(.system(size: 15))
                .foregroundStyle(palette.ink.opacity(0.65))
                .italic()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - List Rendering

    /// Bullets and numbers get their own gutter so wrapped lines hang under
    /// the text, not under the marker. Nesting indents by depth.
    private func listView(_ list: MarkdownList) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(list.items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.marker)
                        .font(
                            .system(
                                size: 15, weight: list.ordered ? .medium : .regular)
                        )
                        .monospacedDigit()
                        .foregroundStyle(palette.ink.opacity(0.55))
                        .frame(minWidth: list.ordered ? 22 : 12, alignment: .trailing)
                    inlineText(item.text)
                        .font(.system(size: 15))
                        .foregroundStyle(palette.ink.opacity(0.9))
                        .tint(palette.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, CGFloat(item.depth) * 16)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Table Rendering

    /// Pipe tables follow the web contract for
    /// `slicc-agent-message .body table`: a rounded, hairline-ruled card
    /// that **hugs its content** (`width: fit-content`) and scrolls inside
    /// itself when a comparison is wider than the transcript column. The
    /// card must not stretch — a three-column table spread across an iPad
    /// reads as a layout bug, and the leader emits narrow tables routinely.
    ///
    /// Rows are stacked rather than gridded: `MarkdownTableLayout` already
    /// resolves the column widths, and `Grid` reserves each row's height
    /// before a capped cell has wrapped, which clips the last row away.
    private func tableView(_ table: MarkdownTable) -> some View {
        let widths = MarkdownTableLayout.columnWidths(for: table)
        let totalWidth = widths.reduce(0, +)
        return VStack(spacing: 0) {
            tableRow(table.header, table: table, widths: widths, isHeader: true)
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                Rectangle()
                    .fill(palette.line)
                    .frame(width: totalWidth, height: 1)
                tableRow(row, table: table, widths: widths, isHeader: false)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(palette.line, lineWidth: 1)
        )
        .horizontalScrollGuard()
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tableRow(
        _ cells: [String], table: MarkdownTable, widths: [CGFloat], isHeader: Bool
    ) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(widths.enumerated()), id: \.offset) { column, width in
                tableCell(
                    cells[safe: column] ?? "",
                    alignment: table.alignments[safe: column] ?? .leading,
                    isHeader: isHeader, column: column, width: width)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// One cell. `border-collapse: collapse` is emulated by drawing only the
    /// leading rule, and only for columns after the first — the outer stroke
    /// supplies the frame and the row rules the horizontal lines, so no edge
    /// is ever painted twice.
    private func tableCell(
        _ text: String, alignment: MarkdownTable.Alignment, isHeader: Bool,
        column: Int, width: CGFloat
    ) -> some View {
        inlineText(text)
            .font(
                .system(
                    size: MarkdownTableLayout.bodyFontSize,
                    weight: isHeader ? .semibold : .regular)
            )
            .foregroundStyle(palette.ink.opacity(isHeader ? 1.0 : 0.85))
            .multilineTextAlignment(alignment.textAlignment)
            // A capped column wraps; without this the cell keeps its
            // single-line ideal height and truncates the overflow away,
            // which puts the text out of reach — the scroller only pans
            // the card, it cannot reveal an ellipsis.
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, MarkdownTableLayout.cellHorizontalPadding)
            .padding(.vertical, MarkdownTableLayout.cellVerticalPadding)
            .frame(width: width, alignment: alignment.frameAlignment)
            // Ghost header fill and the column rule have to span the whole
            // row, not just this cell's own text height.
            .frame(maxHeight: .infinity, alignment: .top)
            .background(isHeader ? palette.field : Color.clear)
            .overlay(alignment: .leading) {
                if column > 0 {
                    Rectangle().fill(palette.line).frame(width: 1)
                }
            }
    }

    // MARK: - Code Block Rendering

    private func codeBlockView(language: String?, code: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(palette.ink.opacity(0.4))
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
            }
            Text(code)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(palette.ink.opacity(0.85))
                .padding(.horizontal, 12)
                .padding(.vertical, language != nil ? 4 : 12)
                .padding(.bottom, 8)
                .textSelection(.enabled)
                .horizontalScrollGuard()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.field)
        .cornerRadius(8)
    }
}

// MARK: - Alignment bridging

extension MarkdownTable.Alignment {
    var textAlignment: TextAlignment {
        switch self {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    var frameAlignment: Alignment {
        switch self {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

extension Array {
    /// Bounds-checked subscript. A malformed table can carry more cells than
    /// the delimiter row declared alignments for; a crash there would take
    /// the whole transcript down.
    fileprivate subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

// MARK: - Shared inline-code styling

/// Walk the AttributedString runs and apply a background pill + monospace
/// font to `inlinePresentationIntent: .code` ranges so backticked tokens
/// read as code and not just italic-ish prose. The markdown parser
/// already tags them; we just style the runs. Colors are passed in
/// because the assistant message background and the user-bubble accent
/// purple need different contrast — see `MarkdownText.styledForInlineCode`
/// and `MessageBubble.styleUserBubbleCode` for the two call sites.
func styledInlineCode(
    _ input: AttributedString,
    background: Color,
    foreground: Color,
    fontSize: CGFloat = 14
) -> AttributedString {
    var output = input
    for run in output.runs {
        if let intent = run.inlinePresentationIntent, intent.contains(.code) {
            output[run.range].font = .system(size: fontSize, design: .monospaced)
            output[run.range].backgroundColor = background
            output[run.range].foregroundColor = foreground
        }
    }
    return output
}

// MARK: - Preview

#Preview {
    ScrollView {
        MarkdownText(
            content: """
                # Hello World

                This is **bold** and *italic* and `inline code`.

                | Lens | Reach | Price |
                |------|:-----:|------:|
                | Leica 100-400 | 800mm-eq | €750-1.010 |
                | OM 100-400 | 800mm-eq | €650-850 |

                ```swift
                func hello() {
                    print("Hello, world!")
                }
                ```

                - Item one
                - Item two
                  - Nested item
                1. First
                2. Second

                ---

                Some more text with a [link](https://example.com).
                """
        )
        .padding()
    }
    .background(Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255))
}
