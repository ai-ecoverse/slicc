import SliccTrayKit
import SwiftUI
















struct MessageBubble: View, Equatable {
    let message: ChatMessage
    
    
    
    var toolProgress: [String: ToolProgressEvent] = [:]

    @Environment(\.palette) private var palette
    @Environment(\.inlineSprinkleLick) private var onInlineSprinkleLick

    
    
    
    
    static func == (lhs: MessageBubble, rhs: MessageBubble) -> Bool {
        lhs.message == rhs.message && lhs.toolProgress == rhs.toolProgress
    }

    
    
    private var isLick: Bool {
        if message.source == "lick" { return true }
        if let channel = message.channel, LickRow.isLickChannel(channel) { return true }
        return false
    }

    var body: some View {
        
        
        
        
        
        
        
        
        
        
        if let compaction = message.compaction {
            if compaction.state != .discarded {
                CompactionMarkerRow(marker: compaction)
            }
        } else if isLick {
            LickRow(message: message)
                .padding(.horizontal, 4)
        } else if message.error == true, message.role != .user {
            
            
            
            
            ErrorCard(message: message)
        } else if message.role == .user {
            VStack(alignment: .trailing, spacing: 6) {
                if let attachments = message.attachments, !attachments.isEmpty {
                    AttachmentChips(attachments: attachments)
                }
                
                if !message.content.isEmpty {
                    HStack {
                        Spacer(minLength: UIScreen.main.bounds.width * 0.2)
                        userBubbleText
                            .font(.system(size: 15))
                            .foregroundStyle(palette.bubbleText)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(palette.bubble)
                            .cornerRadius(18)
                    }
                }
                if message.error == true {
                    Text("Not delivered")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("send-failed-note")
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if let source = message.source, source != "cone" {
                    HStack(spacing: 4) {
                        
                        
                        
                        if message.channel?.isEmpty == false {
                            SliccGlyphView(
                                glyph: SliccIcons.messageSource(message), size: 10)
                        } else {
                            ConeScoopGlyph(isCone: false, size: 11)
                        }
                        Text(source)
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(palette.ink.opacity(0.45))
                    .padding(.horizontal, 4)
                }
                assistantBody
            }
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    @ViewBuilder
    private var userBubbleText: some View {
        
        
        
        let body = DictationPriming.stripMarkers(message.content)
        
        
        
        let annotated = TranscriptInlineCache.shared.paragraph(markdown: body, files: [:])
        Text(styleUserBubbleCode(annotated.attributed))
            .tint(palette.bubbleText)
    }

    
    
    
    
    
    
    private func styleUserBubbleCode(_ input: AttributedString) -> AttributedString {
        return styledInlineCode(
            input,
            background: palette.bubbleText.opacity(0.22),
            foreground: palette.bubbleText
        )
    }

    @ViewBuilder
    private var assistantBody: some View {
        
        
        let extracted = extractInlineSprinkles(
            from: DictationPriming.stripReplyLangMarker(message.content))
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

    
    
    
    @ViewBuilder
    private func renderInlineContent(cleaned: String, fragments: [String]) -> some View {
        let segments = splitIntoSegments(cleaned, fragments: fragments)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .markdown(let text):
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        MarkdownText(content: text)
                    }
                case .sprinkle(let fragment, let frameId):
                    InlineSprinkleHost(
                        id: "\(message.id)-\(frameId)",
                        html: fragment,
                        onLick: { body, target in
                            onInlineSprinkleLick(body, target)
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

    

    private var streamingIndicator: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(palette.ink.opacity(0.5))
                    .frame(width: 5, height: 5)
                    .modifier(PulsingDot(delay: Double(i) * 0.2))
            }
        }
        .padding(.top, 2)
    }

    

    @ViewBuilder
    private func toolCallsSection(_ toolCalls: [ToolCall]) -> some View {
        ForEach(Array(groupToolCalls(toolCalls).enumerated()), id: \.offset) { _, group in
            switch group {
            case .single(let tc):
                singleToolCallRow(tc)
            case .cluster(let tcs):
                workingClusterRow(tcs)
            }
        }
    }

    
    
    
    @ViewBuilder
    private func singleToolCallRow(_ tc: ToolCall) -> some View {
        let unit = toolProgress[tc.id]
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 4) {
                
                
                
                if let unit {
                    ToolProgressBar(unit: unit, color: palette.accent)
                        .padding(.bottom, 2)
                }
                if let preview = toolPreview(for: tc), !preview.isEmpty {
                    Text(preview)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(palette.ink.opacity(0.55))
                        .textSelection(.enabled)
                }
                if let result = tc.result {
                    let abbreviated =
                        result.count > 300
                        ? String(result.prefix(300)) + "…" : result
                    Text(abbreviated)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(
                            tc.isError == true
                                ? Color.red.opacity(0.8) : palette.ink.opacity(0.6)
                        )
                        .textSelection(.enabled)
                }
            }
            .padding(.top, 2)
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(SliccIcons.toolStatusColor(tc))
                    .frame(width: 6, height: 6)
                ToolProgressIcon(
                    glyph: SliccIcons.tool(tc.name), size: 11, unit: unit,
                    base: palette.ink.opacity(0.55), accent: palette.accent)
                Text(SliccIcons.toolTitle(tc.name))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(palette.ink.opacity(0.7))
                if let preview = toolPreview(for: tc), !preview.isEmpty {
                    Text(preview)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(palette.ink.opacity(0.4))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if let unit {
                    
                    
                    Spacer(minLength: 4)
                    Text(toolProgressCaption(unit))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(palette.ink.opacity(0.45))
                        .lineLimit(1)
                        .accessibilityHidden(true)
                    ToolProgressDots(unit: unit, color: palette.ink.opacity(0.7))
                } else if tc.result == nil {
                    ProgressView()
                        .scaleEffect(0.5)
                        .frame(width: 12, height: 12)
                }
            }
        }
        .tint(palette.ink.opacity(0.4))
    }

    
    
    
    
    @ViewBuilder
    private func workingClusterRow(_ toolCalls: [ToolCall]) -> some View {
        let aggregate = aggregateToolProgress(calls: toolCalls, progress: toolProgress)
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(toolCalls) { tc in
                    singleToolCallRow(tc)
                }
            }
            .padding(.leading, 10)
            .padding(.top, 4)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(palette.ink.opacity(0.10))
                    .frame(width: 2)
            }
        } label: {
            HStack(spacing: 6) {
                ToolProgressIcon(
                    systemName: "gearshape.fill", size: 11, unit: nil,
                    base: palette.ink.opacity(0.55), accent: palette.accent)
                Text("Working")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(palette.ink.opacity(0.7))
                Text(clusterPreview(for: toolCalls))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(palette.ink.opacity(0.4))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                if let aggregate {
                    Text(toolProgressCaption(aggregate))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(palette.ink.opacity(0.45))
                        .lineLimit(1)
                        .accessibilityHidden(true)
                    ToolProgressDots(unit: aggregate, color: palette.ink.opacity(0.7))
                } else {
                    clusterDots(for: toolCalls)
                }
            }
        }
        .tint(.white.opacity(0.4))
    }

    
    
    
    
    
    
    
    @ViewBuilder
    private func clusterDots(for toolCalls: [ToolCall]) -> some View {
        HStack(spacing: 4) {
            ForEach(toolCalls) { tc in
                Circle()
                    .fill(SliccIcons.toolStatusColor(tc))
                    .frame(width: 5, height: 5)
                    .accessibilityLabel("\(SliccIcons.toolTitle(tc.name)): \(toolStatusLabel(for: tc))")
            }
        }
    }

    
    
    private func toolStatusLabel(for tc: ToolCall) -> String {
        if tc.isError == true { return "error" }
        if tc.result == nil { return "running" }
        return "done"
    }

    
    
    
    
    private func clusterPreview(for toolCalls: [ToolCall]) -> String {
        let joined = toolCalls.map { SliccIcons.toolTitle($0.name) }.joined(separator: ", ")
        guard joined.count > 80 else { return joined }
        return String(joined.prefix(80)) + "…"
    }
}





private enum ToolGroup {
    case single(ToolCall)
    case cluster([ToolCall])
}




private let toolClusterMin = 3






private func groupToolCalls(_ toolCalls: [ToolCall]) -> [ToolGroup] {
    if toolCalls.isEmpty { return [] }
    if toolCalls.count < toolClusterMin {
        return toolCalls.map { .single($0) }
    }
    return [.cluster(toolCalls)]
}

extension MessageBubble {

    
    
    
    
    fileprivate func toolPreview(for tc: ToolCall) -> String? {
        guard let input = tc.input?.value as? [String: Any] else { return nil }
        switch tc.name {
        case "read_file", "write_file", "edit", "edit_file":
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






struct LickRow: View {
    let message: ChatMessage

    @State private var isExpanded = false

    private static let known: Set<String> = [
        "webhook", "cron", "sprinkle", "fswatch",
        "session-reload", "navigate", "upgrade",
        "scoop-notify", "scoop-idle", "scoop-wait",
        "sudo-request",
    ]

    static func isLickChannel(_ channel: String) -> Bool {
        known.contains(channel)
    }

    @Environment(\.palette) private var palette

    private var pillBackground: Color { palette.surface }
    private var bodyBackground: Color { palette.field }
    private var borderColor: Color { palette.ink.opacity(0.06) }

    private var channel: String { message.channel ?? "" }
    private var label: String { SliccIcons.lickLabel(channel) }
    private var icon: SliccGlyph {
        SliccIcons.lick(channel, sprinkleName: parseSprinkleName())
    }

    
    private func parseSprinkleName() -> String? {
        guard channel == "sprinkle" else { return nil }
        guard
            let m = LickRow.headerRegex.firstMatch(
                in: message.content,
                range: NSRange(message.content.startIndex..., in: message.content)
            )
        else { return nil }
        if let r = Range(m.range(at: 2), in: message.content) {
            return String(message.content[r]).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    private var parsed: (preview: String, body: String) {
        LickRow.parseLickContent(message.content)
    }

    
    
    private var previewLabel: String {
        let count = message.lickCount ?? 1
        guard count > 1 else { return parsed.preview }
        return parsed.preview.isEmpty ? "×\(count)" : "\(parsed.preview) ×\(count)"
    }

    
    
    
    private var bodies: [String] {
        guard let parts = message.lickParts, parts.count > 1 else {
            return parsed.body.isEmpty ? [] : [parsed.body]
        }
        return parts.map { LickRow.parseLickContent($0).body }
            .filter { !$0.isEmpty }
    }

    
    
    private var contentOpacity: Double {
        message.lickState == .dismissed ? 0.62 : 1
    }

    private func stateColor(_ state: LickState) -> Color {
        switch state {
        case .confirmed: return Color(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255)
        case .dismissed: return Color(red: 0xF8 / 255, green: 0x71 / 255, blue: 0x71 / 255)
        case .pending: return .white.opacity(0.5)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Text(label)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(palette.ink.opacity(0.85))
                    if !previewLabel.isEmpty {
                        Text(previewLabel)
                            .font(.system(size: 13))
                            .foregroundStyle(palette.ink.opacity(0.55))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 6)
                    if let state = message.lickState,
                        let glyph = SliccIcons.lickState(state)
                    {
                        Image(systemName: glyph)
                            .font(.system(size: 13))
                            .foregroundStyle(stateColor(state))
                            .accessibilityIdentifier("lick-state-\(state.rawValue)")
                    }
                    SliccGlyphView(glyph: icon, size: 13)
                        .foregroundStyle(palette.ink.opacity(0.5))
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

            if isExpanded, !bodies.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(bodies.enumerated()), id: \.offset) { index, body in
                        Text(body)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(palette.ink.opacity(0.75))
                            .textSelection(.enabled)
                            .padding(12)
                            .horizontalScrollGuard(showsIndicators: false)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(bodyBackground)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(borderColor, lineWidth: 0.5)
                            )
                            .accessibilityIdentifier("lick-part-\(index)")
                    }
                }
                .padding(.top, 4)
            }
        }
        .opacity(contentOpacity)
    }

    

    private static let headerRegex: NSRegularExpression = {
        
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
            let header = Range(m.range, in: content)
        {
            let preview = String(content[summary]).trimmingCharacters(in: .whitespaces)
            let body = stripFences(
                String(content[header.upperBound...])
                    .trimmingCharacters(in: .whitespaces))
            return (preview, body)
        }
        if let m = scoopHeaderRegex.firstMatch(in: content, range: full),
            let nameR = Range(m.range(at: 1), in: content),
            let kwR = Range(m.range(at: 2), in: content),
            let header = Range(m.range, in: content)
        {
            let name = String(content[nameR]).trimmingCharacters(in: .whitespaces)
            let kw = String(content[kwR])
            let body = stripFences(
                String(content[header.upperBound...])
                    .trimmingCharacters(in: .whitespaces))
            return ("\(name) \(kw)", body)
        }
        if let m = headerRegex.firstMatch(in: content, range: full),
            let nameR = Range(m.range(at: 2), in: content),
            let header = Range(m.range, in: content)
        {
            let preview = String(content[nameR]).trimmingCharacters(in: .whitespaces)
            let body = stripFences(
                String(content[header.upperBound...])
                    .trimmingCharacters(in: .whitespaces))
            return (preview, body)
        }
        let firstLine =
            content.split(whereSeparator: \.isNewline)
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map(String.init) ?? ""
        let preview = String(firstLine.prefix(80))
        return (preview.trimmingCharacters(in: .whitespaces), stripFences(content))
    }

    
    
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



#Preview {
    VStack(spacing: 12) {
        MessageBubble(
            message: ChatMessage(
                id: "1", role: .user, content: "Hello!",
                timestamp: Date().timeIntervalSince1970 * 1000))
        MessageBubble(
            message: ChatMessage(
                id: "2", role: .assistant, content: "Hi! How can I help you today?",
                timestamp: Date().timeIntervalSince1970 * 1000, isStreaming: true))
    }
    .padding()
    .background(Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255))
}
