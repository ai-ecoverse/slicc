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
                case .heading(let level, let text):
                    headingView(level: level, text: text)
                case .blockquote(let text):
                    blockquoteView(text: text)
                case .codeBlock(let lang, let code):
                    codeBlockView(language: lang, code: code)
                }
            }
        }
    }

    // MARK: - Segment Parsing

    private enum Segment {
        case text(String)
        case heading(level: Int, text: String)
        case blockquote(String)
        case codeBlock(language: String?, code: String)
    }

    private var segments: [Segment] {
        var result: [Segment] = []
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var currentText: [String] = []
        var inCodeBlock = false
        var codeLines: [String] = []
        var codeLang: String?
        var quoteLines: [String] = []

        func flushText() {
            let joined = currentText.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty { result.append(.text(joined)) }
            currentText = []
        }
        func flushQuote() {
            guard !quoteLines.isEmpty else { return }
            // Strip the leading `>` (and optional single space) from each line.
            let body = quoteLines.map { line -> String in
                var s = line
                if s.hasPrefix(">") { s.removeFirst() }
                if s.hasPrefix(" ") { s.removeFirst() }
                return s
            }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty { result.append(.blockquote(body)) }
            quoteLines = []
        }

        for line in lines {
            if !inCodeBlock && line.hasPrefix("```") {
                flushQuote(); flushText()
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
            } else if let heading = parseAtxHeading(line) {
                flushQuote(); flushText()
                result.append(.heading(level: heading.level, text: heading.text))
            } else if line.hasPrefix(">") {
                flushText()
                quoteLines.append(line)
            } else {
                flushQuote()
                currentText.append(line)
            }
        }

        // Flush remaining
        if inCodeBlock {
            // Unclosed code block — render as code anyway
            result.append(.codeBlock(language: codeLang, code: codeLines.joined(separator: "\n")))
        } else {
            flushQuote()
            flushText()
        }

        return result
    }

    /// Parse a leading `# … ######` ATX heading. Returns nil for lines that
    /// aren't headings (so callers fall through to plain text).
    ///
    /// Follows CommonMark's ATX-heading rules:
    /// - 0-3 leading spaces are allowed (4+ → indented code block, not heading).
    /// - The opening `#` run must be followed by whitespace or end-of-line.
    /// - A trailing `#` run is only treated as a closing sequence when it's
    ///   preceded by whitespace; e.g. `# C#` keeps the `#` as part of the
    ///   title, while `# Heading ##` strips the closing `##`.
    private func parseAtxHeading(_ line: String) -> (level: Int, text: String)? {
        // Allow up to 3 leading spaces. 4+ leading spaces is an indented
        // code block in CommonMark, never a heading.
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
        var i = trimmed.startIndex
        while i < trimmed.endIndex, trimmed[i] == "#", level < 6 {
            level += 1
            i = trimmed.index(after: i)
        }
        // Must be followed by whitespace or end-of-line for it to be a heading.
        guard level >= 1 else { return nil }
        if i == trimmed.endIndex { return (level, "") }
        guard trimmed[i] == " " || trimmed[i] == "\t" else { return nil }
        let rawText = String(trimmed[i...])
        // Strip trailing whitespace first.
        var endIdx = rawText.endIndex
        while endIdx > rawText.startIndex,
            rawText[rawText.index(before: endIdx)] == " "
                || rawText[rawText.index(before: endIdx)] == "\t"
        {
            endIdx = rawText.index(before: endIdx)
        }
        // Walk back over a trailing run of `#`. Only treat it as a closing
        // sequence if the character before the run is whitespace (or the
        // entire body is hashes). Otherwise keep them — `# C#` should not
        // become `# C`.
        var hashStart = endIdx
        while hashStart > rawText.startIndex,
            rawText[rawText.index(before: hashStart)] == "#"
        {
            hashStart = rawText.index(before: hashStart)
        }
        let hadTrailingHashes = hashStart < endIdx
        let bodyEnd: String.Index
        if hadTrailingHashes,
            hashStart == rawText.startIndex
                || rawText[rawText.index(before: hashStart)] == " "
                || rawText[rawText.index(before: hashStart)] == "\t"
        {
            bodyEnd = hashStart
        } else {
            bodyEnd = endIdx
        }
        let final = String(rawText[rawText.startIndex..<bodyEnd]).trimmingCharacters(in: .whitespaces)
        return (level, final)
    }

    // MARK: - Text Rendering

    @ViewBuilder
    private func markdownTextView(_ text: String) -> some View {
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(styledForInlineCode(attributed))
                .font(.system(size: 15))
                .foregroundStyle(.white.opacity(0.9))
                .tint(Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255))
        } else {
            Text(text)
                .font(.system(size: 15))
                .foregroundStyle(.white.opacity(0.9))
        }
    }

    /// Apply the assistant-bubble inline-code style: white@10 background,
    /// lavender foreground, 14pt monospace. Wrapper around the shared
    /// `styledInlineCode(...)` helper so the assistant call sites stay
    /// terse.
    private func styledForInlineCode(_ input: AttributedString) -> AttributedString {
        return styledInlineCode(
            input,
            background: Color.white.opacity(0.10),
            foreground: Color(red: 0xC9 / 255, green: 0xBC / 255, blue: 0xFF / 255)
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
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(styledForInlineCode(attributed))
                .font(.system(size: size, weight: weight))
                .foregroundStyle(.white)
        } else {
            Text(text)
                .font(.system(size: size, weight: weight))
                .foregroundStyle(.white)
        }
    }

    // MARK: - Blockquote Rendering

    /// Blockquote: faint left bar + secondary text color. The body itself
    /// is rendered through the same inline parser so nested **bold**,
    /// `code`, links, etc. still work.
    private func blockquoteView(text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(.white.opacity(0.20))
                .frame(width: 3)
            Group {
                if let attributed = try? AttributedString(
                    markdown: text,
                    options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
                ) {
                    Text(styledForInlineCode(attributed))
                } else {
                    Text(text)
                }
            }
            .font(.system(size: 15))
            .foregroundStyle(.white.opacity(0.65))
            .italic()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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

