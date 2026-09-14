import SwiftUI




















struct MarkdownText: View {
    @Environment(\.palette) private var palette
    @Environment(\.fileMentionResolver) private var fileMentionResolver
    @Environment(\.transcriptActions) private var actions

    let content: String

    
    
    
    
    
    
    @State private var resolvedFiles: [String: String] = [:]

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
        .task(id: content) { await resolveMentions() }
    }

    private var blocks: [MarkdownBlock] { MarkdownBlockParser.parse(content) }

    

    
    
    
    
    
    
    private func resolveMentions() async {
        guard let resolver = fileMentionResolver else { return }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        let queries = TranscriptInline.fileQueries(in: content)
        guard !queries.isEmpty else { return }
        let resolved = await resolver.resolve(all: queries)
        guard !Task.isCancelled, resolved != resolvedFiles else { return }
        resolvedFiles = resolved
    }

    
    
    private func paragraph(_ markdown: String) -> TranscriptParagraph {
        TranscriptInlineCache.shared.paragraph(markdown: markdown, files: resolvedFiles)
    }

    

    
    
    
    private func inlineText(_ text: String) -> Text {
        Text(styledForInlineCode(paragraph(text).attributed))
    }

    
    
    private func transcriptText(
        _ value: AttributedString, size: CGFloat = 15, weight: UIFont.Weight = .regular,
        italic: Bool = false, inkOpacity: Double = 0.9
    ) -> some View {
        TranscriptText(
            attributed: value,
            style: TranscriptTextStyle(
                fontSize: size,
                weight: weight,
                italic: italic,
                ink: UIColor(palette.ink).withAlphaComponent(inkOpacity),
                accent: UIColor(palette.accent),
                codeForeground: UIColor(palette.accent),
                codeBackground: UIColor(palette.ink).withAlphaComponent(0.10)
            )
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    
    @ViewBuilder
    private func markdownTextView(_ text: String) -> some View {
        let plan = paragraph(text)
        if plan.segments.count == 1, case .text(let only) = plan.segments[0] {
            transcriptText(only)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(plan.segments.enumerated()), id: \.offset) { _, segment in
                    switch segment {
                    case .text(let value):
                        transcriptText(value)
                    case .payload(let payload):
                        Base64Chip(payload: payload)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    
    
    
    
    private func styledForInlineCode(_ input: AttributedString) -> AttributedString {
        return styledInlineCode(
            input,
            background: palette.ink.opacity(0.10),
            foreground: palette.accent
        )
    }

    

    
    
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

    

    
    
    
    private func blockquoteView(text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(palette.ink.opacity(0.20))
                .frame(width: 3)
            transcriptText(paragraph(text).attributed, italic: true, inkOpacity: 0.65)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    

    
    
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
                    transcriptText(paragraph(item.text).attributed)
                }
                .padding(.leading, CGFloat(item.depth) * 16)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    

    
    
    
    
    
    
    
    
    
    
    private func tableView(_ table: MarkdownTable) -> some View {
        let widths = MarkdownTableLayout.columnWidths(for: table)
        let totalWidth = MarkdownTableLayout.totalWidth(for: table)
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
        
        
        
        
        
        
        .frame(maxWidth: MarkdownTableLayout.totalWidth(for: table), alignment: .leading)
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
            
            
            
            
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, MarkdownTableLayout.cellHorizontalPadding)
            .padding(.vertical, MarkdownTableLayout.cellVerticalPadding)
            .frame(width: width, alignment: alignment.frameAlignment)
            
            
            .frame(maxHeight: .infinity, alignment: .top)
            .background(isHeader ? palette.field : Color.clear)
            .overlay(alignment: .leading) {
                if column > 0 {
                    Rectangle().fill(palette.line).frame(width: 1)
                }
            }
    }

    

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
        .accessibilityIdentifier("code-block")
        
        
        
        
        .contextMenu {
            Button {
                TranscriptClipboard.copy(code)
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            Button {
                actions.share(.text(code))
            } label: {
                Label("Share…", systemImage: "square.and.arrow.up")
            }
        }
    }
}



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
    
    
    
    fileprivate subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}










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
