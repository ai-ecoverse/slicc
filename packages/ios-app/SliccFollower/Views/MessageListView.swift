import SwiftUI

// MARK: - MessageListView

/// Renders chat messages as a scrollable list with auto-scroll to bottom.
struct MessageListView: View {
    let messages: [ChatMessage]
    let isStreaming: Bool
    /// Pending read-only approval placeholders, pinned below the transcript.
    var toolUICards: [ToolUIPlaceholder] = []
    /// Forwarded to inline sprinkle bubbles for `sprinkle.lick` events.
    var onInlineSprinkleLick: ((AnyCodable?, String?) -> Void)?
    /// Owned above ChatView's compact/regular branch so subtree replacement
    /// restores the same viewport instead of jumping to the newest message.
    @Binding var scrollPosition: ScrollPosition

    init(
        messages: [ChatMessage],
        isStreaming: Bool,
        toolUICards: [ToolUIPlaceholder] = [],
        onInlineSprinkleLick: ((AnyCodable?, String?) -> Void)? = nil,
        scrollPosition: Binding<ScrollPosition>
    ) {
        self.messages = messages
        self.isStreaming = isStreaming
        self.toolUICards = toolUICards
        self.onInlineSprinkleLick = onInlineSprinkleLick
        _scrollPosition = scrollPosition
    }

    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            if messages.isEmpty && toolUICards.isEmpty {
                emptyState
            } else {
                messageList
            }
        }
        .background(palette.canvas)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(palette.ink.opacity(0.2))
            Text("No messages yet")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(palette.ink.opacity(0.3))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Message List

    private var messageList: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(groupedMessages) { group in
                    // Timestamp header
                    Text(group.label)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(palette.ink.opacity(0.3))
                        .padding(.top, 12)
                        .padding(.bottom, 4)

                    ForEach(group.messages) { message in
                        MessageBubble(
                            message: message,
                            onInlineSprinkleLick: onInlineSprinkleLick
                        )
                        .id(message.id)
                        .padding(.horizontal, 12)
                        // SwiftUI pushes an identifier down onto the row's
                        // leaf elements rather than minting a container,
                        // so every bubble, pill and tool button inside a
                        // message carries this id. That is what lets UI
                        // tests ask which messages are on screen without
                        // matching on user-visible copy.
                        .accessibilityIdentifier("message-\(message.id)")
                    }
                }

                // Approval placeholders sit after the transcript, matching
                // the leader mounting them outside the message list.
                ForEach(toolUICards) { card in
                    ToolUICardView(card: card)
                        .padding(.horizontal, 12)
                }

                // Invisible anchor at bottom
                Color.clear
                    .frame(height: 1)
                    .id("bottom")
            }
            .scrollTargetLayout()
            .padding(.vertical, 8)
        }
        .scrollPosition($scrollPosition)
        .onChange(of: messages.count) { _, _ in
            scrollToBottom()
        }
        .onChange(of: toolUICards.count) { _, _ in
            scrollToBottom()
        }
        .onChange(of: messages.last?.content) { _, _ in
            scrollToBottom()
        }
    }

    // MARK: - Scroll Helper

    private func scrollToBottom() {
        withAnimation(.easeOut(duration: 0.2)) {
            scrollPosition.scrollTo(edge: .bottom)
        }
    }

    // MARK: - Timestamp Grouping

    private var groupedMessages: [MessageGroup] {
        var groups: [MessageGroup] = []
        let calendar = Calendar.current
        var currentGroup: MessageGroup?

        for message in messages {
            let date = Date(timeIntervalSince1970: message.timestamp / 1000)
            let label = Self.timestampLabel(for: date, calendar: calendar)

            if let existing = currentGroup, existing.label == label {
                currentGroup?.messages.append(message)
            } else {
                if let group = currentGroup {
                    groups.append(group)
                }
                currentGroup = MessageGroup(
                    id: message.id + "_group",
                    label: label,
                    messages: [message]
                )
            }
        }

        if let group = currentGroup {
            groups.append(group)
        }

        return groups
    }

    private static func timestampLabel(for date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        let timeStr = formatter.string(from: date)

        if calendar.isDateInToday(date) {
            return "Today \(timeStr)"
        } else if calendar.isDateInYesterday(date) {
            return "Yesterday \(timeStr)"
        } else {
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            return formatter.string(from: date)
        }
    }
}

// MARK: - MessageGroup

private struct MessageGroup: Identifiable {
    let id: String
    let label: String
    var messages: [ChatMessage]
}

// MARK: - Preview

#Preview {
    MessageListView(
        messages: [
            ChatMessage(
                id: "1", role: .user, content: "Hello!",
                timestamp: Date().timeIntervalSince1970 * 1000),
            ChatMessage(
                id: "2", role: .assistant, content: "Hi there! How can I help?",
                timestamp: Date().timeIntervalSince1970 * 1000),
        ],
        isStreaming: false,
        scrollPosition: .constant(ScrollPosition(idType: String.self, edge: .bottom))
    )
}
