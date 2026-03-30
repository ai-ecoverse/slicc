import SwiftUI

// MARK: - MessageListView

/// Native SwiftUI replacement for MessageWebView.
/// Renders chat messages as a scrollable list with auto-scroll to bottom.
struct MessageListView: View {
    let messages: [ChatMessage]
    let isStreaming: Bool

    private let background = Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255)

    var body: some View {
        Group {
            if messages.isEmpty {
                emptyState
            } else {
                messageList
            }
        }
        .background(background)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(.white.opacity(0.2))
            Text("No messages yet")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.white.opacity(0.3))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Message List

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(groupedMessages) { group in
                        // Timestamp header
                        Text(group.label)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white.opacity(0.3))
                            .padding(.top, 12)
                            .padding(.bottom, 4)

                        ForEach(group.messages) { message in
                            MessageBubble(message: message)
                                .id(message.id)
                                .padding(.horizontal, 12)
                        }
                    }

                    // Invisible anchor at bottom
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.vertical, 8)
            }
            .onChange(of: messages.count) { _ in
                scrollToBottom(proxy: proxy)
            }
            .onChange(of: messages.last?.content) { _ in
                scrollToBottom(proxy: proxy)
            }
            .onAppear {
                scrollToBottom(proxy: proxy, animated: false)
            }
        }
    }

    // MARK: - Scroll Helper

    private func scrollToBottom(proxy: ScrollViewProxy, animated: Bool = true) {
        if animated {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        } else {
            proxy.scrollTo("bottom", anchor: .bottom)
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
            ChatMessage(id: "1", role: .user, content: "Hello!",
                        timestamp: Date().timeIntervalSince1970 * 1000),
            ChatMessage(id: "2", role: .assistant, content: "Hi there! How can I help?",
                        timestamp: Date().timeIntervalSince1970 * 1000),
        ],
        isStreaming: false
    )
}

