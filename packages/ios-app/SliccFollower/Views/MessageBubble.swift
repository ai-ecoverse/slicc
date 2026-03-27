import SwiftUI

// MARK: - MessageBubble

/// Renders a single chat message as a styled bubble.
struct MessageBubble: View {
    let message: ChatMessage

    private let userBubbleColor = Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255)
    private let assistantBubbleColor = Color(red: 0x25 / 255, green: 0x25 / 255, blue: 0x40 / 255)

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: UIScreen.main.bounds.width * 0.2) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
                // Source label for non-cone assistant messages
                if message.role == .assistant, let source = message.source, source != "cone" {
                    Text(source)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white.opacity(0.4))
                        .padding(.horizontal, 4)
                }

                // Message content
                if message.role == .user {
                    Text(message.content)
                        .font(.system(size: 15))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(userBubbleColor)
                        .cornerRadius(18)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        if !message.content.isEmpty {
                            MarkdownText(content: message.content)
                        }

                        // Streaming indicator
                        if message.isStreaming == true {
                            streamingIndicator
                        }

                        // Tool calls
                        if let toolCalls = message.toolCalls, !toolCalls.isEmpty {
                            toolCallsSection(toolCalls)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(assistantBubbleColor)
                    .cornerRadius(14)
                }
            }

            if message.role == .assistant { Spacer(minLength: UIScreen.main.bounds.width * 0.2) }
        }
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
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.4))
                    Text(tc.name)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.6))
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

