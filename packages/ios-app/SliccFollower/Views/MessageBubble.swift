import SwiftUI

// MARK: - MessageBubble

/// Renders a single chat message — user bubbles on the right, lick rows
/// as compact pills (no avatar/bubble), assistant text flowing on the
/// dark background like the web UI.
struct MessageBubble: View {
    let message: ChatMessage
    /// Optional callback for inline sprinkle licks (forwarded to AppState).
    var onInlineSprinkleLick: ((AnyCodable?, String?) -> Void)?

    private let userBubbleColor = Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255)

    /// True when this message should render as a compact lick pill.
    /// Mirrors the web UI rule: source == "lick" or known lick channel.
    private var isLick: Bool {
        if message.source == "lick" { return true }
        if let channel = message.channel, LickRow.isLickChannel(channel) { return true }
        return false
    }

    var body: some View {
        if isLick {
            LickRow(message: message)
                .padding(.horizontal, 4)
        } else if message.role == .user {
            HStack {
                Spacer(minLength: UIScreen.main.bounds.width * 0.2)
                Text(message.content)
                    .font(.system(size: 15))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(userBubbleColor)
                    .cornerRadius(18)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if let source = message.source, source != "cone" {
                    HStack(spacing: 4) {
                        Image(systemName: SliccIcons.messageSource(message))
                            .font(.system(size: 10))
                        Text(source)
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(.white.opacity(0.45))
                    .padding(.horizontal, 4)
                }
                assistantBody
            }
        }
    }

    @ViewBuilder
    private var assistantBody: some View {
        let extracted = extractInlineSprinkles(from: message.content)
        VStack(alignment: .leading, spacing: 8) {
            if !extracted.cleaned.isEmpty || extracted.fragments.isEmpty {
                renderInlineContent(cleaned: extracted.cleaned, fragments: extracted.fragments)
            } else {
                renderInlineContent(cleaned: "", fragments: extracted.fragments)
            }

            if message.isStreaming == true {
                streamingIndicator
            }

            if let toolCalls = message.toolCalls, !toolCalls.isEmpty {
                toolCallsSection(toolCalls)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    /// Renders the cleaned markdown interleaved with extracted shtml fragments.
    /// The cleaned text contains markers `\u{FFFC}\u{FFFC}sprinkle:N\u{FFFC}\u{FFFC}` indicating
    /// where each fragment should appear.
    @ViewBuilder
    private func renderInlineContent(cleaned: String, fragments: [String]) -> some View {
        let segments = splitIntoSegments(cleaned, fragments: fragments)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case let .markdown(text):
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        MarkdownText(content: text)
                    }
                case let .sprinkle(fragment, frameId):
                    InlineSprinkleHost(
                        id: "\(message.id)-\(frameId)",
                        html: fragment,
                        onLick: { body, target in
                            onInlineSprinkleLick?(body, target)
                        }
                    )
                }
            }
        }
    }

    private enum InlineSegment {
        case markdown(String)
        case sprinkle(String, Int)
    }

    private func splitIntoSegments(_ cleaned: String, fragments: [String]) -> [InlineSegment] {
        guard !fragments.isEmpty else { return [.markdown(cleaned)] }
        var result: [InlineSegment] = []
        var remaining = cleaned[...]
        let marker = "\u{FFFC}\u{FFFC}sprinkle:"
        while let openRange = remaining.range(of: marker) {
            result.append(.markdown(String(remaining[remaining.startIndex..<openRange.lowerBound])))
            let afterMarker = openRange.upperBound
            if let closeRange = remaining.range(
                of: "\u{FFFC}\u{FFFC}", range: afterMarker..<remaining.endIndex
            ) {
                let idStr = remaining[afterMarker..<closeRange.lowerBound]
                if let idx = Int(idStr), idx >= 0, idx < fragments.count {
                    result.append(.sprinkle(fragments[idx], idx))
                }
                remaining = remaining[closeRange.upperBound...]
            } else {
                break
            }
        }
        if !remaining.isEmpty {
            result.append(.markdown(String(remaining)))
        }
        return result
    }

    // MARK: - Streaming Indicator

    private var streamingIndicator: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(.white.opacity(0.5))
                    .frame(width: 5, height: 5)
                    .modifier(PulsingDot(delay: Double(i) * 0.2))
            }
        }
        .padding(.top, 2)
    }

    // MARK: - Tool Calls

    @ViewBuilder
    private func toolCallsSection(_ toolCalls: [ToolCall]) -> some View {
        ForEach(toolCalls) { tc in
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 4) {
                    if let preview = toolPreview(for: tc), !preview.isEmpty {
                        Text(preview)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.55))
                            .textSelection(.enabled)
                    }
                    if let result = tc.result {
                        let abbreviated = result.count > 300
                            ? String(result.prefix(300)) + "…" : result
                        Text(abbreviated)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(
                                tc.isError == true
                                    ? Color.red.opacity(0.8) : .white.opacity(0.6))
                            .textSelection(.enabled)
                    }
                }
                .padding(.top, 2)
            } label: {
                HStack(spacing: 6) {
                    Circle()
                        .fill(SliccIcons.toolStatusColor(tc))
                        .frame(width: 6, height: 6)
                    Image(systemName: SliccIcons.tool(tc.name))
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.55))
                    Text(SliccIcons.toolTitle(tc.name))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.7))
                    if let preview = toolPreview(for: tc), !preview.isEmpty {
                        Text(preview)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    if tc.result == nil {
                        ProgressView()
                            .scaleEffect(0.5)
                            .frame(width: 12, height: 12)
                    }
                }
            }
            .tint(.white.opacity(0.4))
        }
    }

    /// Short preview string for a tool call's input — mirrors the web UI's
    /// per-tool preview (path for read/write, command for bash, etc.).
    private func toolPreview(for tc: ToolCall) -> String? {
        guard let input = tc.input?.value as? [String: Any] else { return nil }
        switch tc.name {
        case "read_file", "write_file", "edit_file":
            return input["path"] as? String
        case "bash":
            if let cmd = input["command"] as? String {
                let trimmed = cmd.trimmingCharacters(in: .whitespacesAndNewlines)
                return "$ " + (trimmed.count > 100 ? String(trimmed.prefix(100)) + "…" : trimmed)
            }
            return nil
        case "send_message":
            if let text = input["text"] as? String {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.count > 80 ? String(trimmed.prefix(80)) + "…" : trimmed
            }
            return nil
        case "feed_scoop", "drop_scoop", "delegate_to_scoop":
            return input["scoop_name"] as? String
        case "scoop_scoop", "register_scoop":
            return input["name"] as? String
        case "schedule_task":
            return input["cron"] as? String ?? input["name"] as? String
        default:
            return nil
        }
    }
}

// MARK: - InlineSprinkleHost

/// SwiftUI host for InlineSprinkleView that owns its current dynamic height.
private struct InlineSprinkleHost: View {
    let id: String
    let html: String
    var onLick: (AnyCodable?, String?) -> Void

    @State private var height: CGFloat = 80

    var body: some View {
        InlineSprinkleView(
            id: id,
            html: html,
            onLick: onLick,
            onHeightChange: { newHeight in
                if abs(newHeight - height) > 1 {
                    height = newHeight
                }
            }
        )
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - LickRow

/// Compact pill row for lick messages (webhook/cron/sprinkle/...). Mirrors
/// the web UI's `.lick` rendering — channel label + event preview, with
/// the body (typically JSON) hidden behind a tap-to-expand disclosure.
struct LickRow: View {
    let message: ChatMessage

    @State private var isExpanded = false

    private static let known: Set<String> = [
        "webhook", "cron", "sprinkle", "fswatch",
        "session-reload", "navigate", "upgrade",
        "scoop-notify", "scoop-idle", "scoop-wait",
    ]

    static func isLickChannel(_ channel: String) -> Bool {
        known.contains(channel)
    }

    private let pillBackground = Color(red: 0x1B / 255, green: 0x1B / 255, blue: 0x2A / 255)
    private let bodyBackground = Color(red: 0x14 / 255, green: 0x14 / 255, blue: 0x22 / 255)
    private let borderColor = Color.white.opacity(0.06)

    private var channel: String { message.channel ?? "" }
    private var label: String { SliccIcons.lickLabel(channel) }
    private var iconName: String {
        SliccIcons.lick(channel, sprinkleName: parseSprinkleName())
    }

    /// Sprinkle event name parsed from `[Sprinkle Event: <name>]` header.
    private func parseSprinkleName() -> String? {
        guard channel == "sprinkle" else { return nil }
        guard let m = LickRow.headerRegex.firstMatch(
            in: message.content,
            range: NSRange(message.content.startIndex..., in: message.content)
        ) else { return nil }
        if let r = Range(m.range(at: 2), in: message.content) {
            return String(message.content[r]).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    private var parsed: (preview: String, body: String) {
        LickRow.parseLickContent(message.content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Text(label)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                    if !parsed.preview.isEmpty {
                        Text(parsed.preview)
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.55))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 6)
                    Image(systemName: iconName)
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.5))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(pillBackground)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(borderColor, lineWidth: 0.5)
                )
            }
            .buttonStyle(.plain)

            if isExpanded, !parsed.body.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(parsed.body)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.75))
                        .textSelection(.enabled)
                        .padding(12)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(bodyBackground)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(borderColor, lineWidth: 0.5)
                )
                .padding(.top, 4)
            }
        }
    }

    // MARK: Header parsing — mirrors lick-view.ts parseLickContent

    private static let headerRegex: NSRegularExpression = {
        // [Xyz Event: name]\n  OR  [Xyz: name]\n
        try! NSRegularExpression(pattern: #"^\[([^\]:]+?)(?:\s+Event)?:\s*([^\]]+?)\]\s*\n?"#)
    }()

    private static let scoopHeaderRegex: NSRegularExpression = {
        try! NSRegularExpression(pattern: #"^\[@([^\]]+?)\s+(completed|idle)\]\s*:?\s*\n?"#)
    }()

    private static let scoopWaitHeaderRegex: NSRegularExpression = {
        try! NSRegularExpression(pattern: #"^\[scoop_wait completed\]\s*\n([^\n]+)\n?"#)
    }()

    static func parseLickContent(_ content: String) -> (preview: String, body: String) {
        let full = NSRange(content.startIndex..., in: content)
        if let m = scoopWaitHeaderRegex.firstMatch(in: content, range: full),
           let summary = Range(m.range(at: 1), in: content),
           let header = Range(m.range, in: content) {
            let preview = String(content[summary]).trimmingCharacters(in: .whitespaces)
            let body = stripFences(String(content[header.upperBound...])
                .trimmingCharacters(in: .whitespaces))
            return (preview, body)
        }
        if let m = scoopHeaderRegex.firstMatch(in: content, range: full),
           let nameR = Range(m.range(at: 1), in: content),
           let kwR = Range(m.range(at: 2), in: content),
           let header = Range(m.range, in: content) {
            let name = String(content[nameR]).trimmingCharacters(in: .whitespaces)
            let kw = String(content[kwR])
            let body = stripFences(String(content[header.upperBound...])
                .trimmingCharacters(in: .whitespaces))
            return ("\(name) \(kw)", body)
        }
        if let m = headerRegex.firstMatch(in: content, range: full),
           let nameR = Range(m.range(at: 2), in: content),
           let header = Range(m.range, in: content) {
            let preview = String(content[nameR]).trimmingCharacters(in: .whitespaces)
            let body = stripFences(String(content[header.upperBound...])
                .trimmingCharacters(in: .whitespaces))
            return (preview, body)
        }
        let firstLine = content.split(whereSeparator: \.isNewline)
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map(String.init) ?? ""
        let preview = String(firstLine.prefix(80))
        return (preview.trimmingCharacters(in: .whitespaces), stripFences(content))
    }

    /// Strip a leading ```lang fence and trailing ``` fence so the expanded
    /// body shows the raw payload (matches the web UI's rendered markdown).
    private static func stripFences(_ text: String) -> String {
        var s = text
        if let fence = s.range(of: #"^```[a-zA-Z0-9]*\n"#, options: .regularExpression) {
            s.removeSubrange(fence)
        }
        if s.hasSuffix("```") {
            s.removeLast(3)
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - PulsingDot Modifier

private struct PulsingDot: ViewModifier {
    let delay: Double
    @State private var isAnimating = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(isAnimating ? 1.3 : 0.7)
            .opacity(isAnimating ? 1.0 : 0.3)
            .animation(
                .easeInOut(duration: 0.6)
                    .repeatForever(autoreverses: true)
                    .delay(delay),
                value: isAnimating
            )
            .onAppear { isAnimating = true }
    }
}

// MARK: - Preview

#Preview {
    VStack(spacing: 12) {
        MessageBubble(message: ChatMessage(
            id: "1", role: .user, content: "Hello!",
            timestamp: Date().timeIntervalSince1970 * 1000))
        MessageBubble(message: ChatMessage(
            id: "2", role: .assistant, content: "Hi! How can I help you today?",
            timestamp: Date().timeIntervalSince1970 * 1000, isStreaming: true))
    }
    .padding()
    .background(Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255))
}

