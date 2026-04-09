import SwiftUI

// MARK: - MarkdownText

/// Renders markdown content as styled SwiftUI views.
/// Handles fenced code blocks specially since AttributedString(markdown:) doesn't support them well.
struct MarkdownText: View {
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let text):
                    markdownTextView(text)
                case .codeBlock(let lang, let code):
                    codeBlockView(language: lang, code: code)
                }
            }
        }
    }

    // MARK: - Segment Parsing

    private enum Segment {
        case text(String)
        case codeBlock(language: String?, code: String)
    }

    private var segments: [Segment] {
        var result: [Segment] = []
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var currentText: [String] = []
        var inCodeBlock = false
        var codeLines: [String] = []
        var codeLang: String?

        for line in lines {
            if !inCodeBlock && line.hasPrefix("```") {
                // Flush accumulated text
                let joined = currentText.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                if !joined.isEmpty {
                    result.append(.text(joined))
                }
                currentText = []
                inCodeBlock = true
                let langStr = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                codeLang = langStr.isEmpty ? nil : langStr
                codeLines = []
            } else if inCodeBlock && line.hasPrefix("```") {
                result.append(.codeBlock(language: codeLang, code: codeLines.joined(separator: "\n")))
                inCodeBlock = false
                codeLines = []
                codeLang = nil
            } else if inCodeBlock {
                codeLines.append(line)
            } else {
                currentText.append(line)
            }
        }

        // Flush remaining
        if inCodeBlock {
            // Unclosed code block — render as code anyway
            result.append(.codeBlock(language: codeLang, code: codeLines.joined(separator: "\n")))
        } else {
            let joined = currentText.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                result.append(.text(joined))
            }
        }

        return result
    }

    // MARK: - Text Rendering

    @ViewBuilder
    private func markdownTextView(_ text: String) -> some View {
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
                .font(.system(size: 15))
                .foregroundStyle(.white.opacity(0.9))
                .tint(Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255))
        } else {
            Text(text)
                .font(.system(size: 15))
                .foregroundStyle(.white.opacity(0.9))
        }
    }

    // MARK: - Code Block Rendering

    private func codeBlockView(language: String?, code: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.4))
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
            }
            ScrollView(.horizontal, showsIndicators: true) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 12)
                    .padding(.vertical, language != nil ? 4 : 12)
                    .padding(.bottom, 8)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(red: 0x1A / 255, green: 0x1A / 255, blue: 0x2E / 255))
        .cornerRadius(8)
    }
}

// MARK: - Preview

#Preview {
    ScrollView {
        MarkdownText(content: """
        # Hello World

        This is **bold** and *italic* and `inline code`.

        ```swift
        func hello() {
            print("Hello, world!")
        }
        ```

        - Item one
        - Item two
        - Item three

        Some more text with a [link](https://example.com).
        """)
        .padding()
    }
    .background(Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255))
}

