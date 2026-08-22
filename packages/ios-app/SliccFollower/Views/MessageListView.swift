import SliccTrayKit
import SwiftUI

// MARK: - MessageListView

enum MessageListLayout {
    /// Keeps long-form assistant responses readable on regular-width iPads while
    /// allowing compact and split-view transcripts to use all available space.
    static let maximumReadableWidth: CGFloat = 680
}

extension View {
    /// Caps one transcript row at the readable column width.
    ///
    /// The cap lives on the **rows**, not on the stack around them. The
    /// `LazyVStack` carries `scrollTargetLayout()`, which makes it the scroll
    /// view's anchor: a centering frame wrapped *around* the target layout is
    /// undone by an equal and opposite content offset, so the capped column
    /// snapped back to the leading edge instead of centering (#1938 follow-up).
    /// Capping rows instead keeps the target layout full-width — nothing to
    /// scroll away — and the stack's own `.center` alignment does the
    /// centering.
    fileprivate func readableTranscriptColumn() -> some View {
        frame(maxWidth: MessageListLayout.maximumReadableWidth)
    }
}

/// Renders chat messages as a scrollable list with auto-scroll to bottom.
struct MessageListView: View {
    let messages: [ChatMessage]
    let isStreaming: Bool
    /// Live tool-call progress units keyed by tool row id, straight from
    /// `AppState.toolProgress`. Empty for frozen sessions and plain history.
    var toolProgress: [String: ToolProgressEvent] = [:]
    /// Pending read-only approval placeholders, pinned below the transcript.
    var toolUICards: [ToolUIPlaceholder] = []
    /// Pending native external-app approvals, separate from read-only tool UI.
    var openApprovals: [OpenApprovalRequest] = []
    var onOpenApprovalDecision: ((String, OpenApprovalDecision) -> Void)?
    /// Delegated sudo prompts (#2062), same treatment as the open approvals.
    var sudoApprovals: [SudoApprovalRequest] = []
    var sudoAllowAlways = false
    var onSudoApprovalDecision: ((String, SudoApprovalDecision) -> Void)?
    /// Forwarded to inline sprinkle bubbles for `sprinkle.lick` events.
    var onInlineSprinkleLick: ((AnyCodable?, String?) -> Void)?
    /// Owned above ChatView's compact/regular branch so subtree replacement
    /// restores the same viewport instead of jumping to the newest message.
    @Binding var scrollPosition: ScrollPosition

    init(
        messages: [ChatMessage],
        isStreaming: Bool,
        toolProgress: [String: ToolProgressEvent] = [:],
        toolUICards: [ToolUIPlaceholder] = [],
        openApprovals: [OpenApprovalRequest] = [],
        onOpenApprovalDecision: ((String, OpenApprovalDecision) -> Void)? = nil,
        sudoApprovals: [SudoApprovalRequest] = [],
        sudoAllowAlways: Bool = false,
        onSudoApprovalDecision: ((String, SudoApprovalDecision) -> Void)? = nil,
        onInlineSprinkleLick: ((AnyCodable?, String?) -> Void)? = nil,
        scrollPosition: Binding<ScrollPosition>
    ) {
        self.messages = messages
        self.isStreaming = isStreaming
        self.toolProgress = toolProgress
        self.toolUICards = toolUICards
        self.openApprovals = openApprovals
        self.onOpenApprovalDecision = onOpenApprovalDecision
        self.sudoApprovals = sudoApprovals
        self.sudoAllowAlways = sudoAllowAlways
        self.onSudoApprovalDecision = onSudoApprovalDecision
        self.onInlineSprinkleLick = onInlineSprinkleLick
        _scrollPosition = scrollPosition
    }

    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            if messages.isEmpty && toolUICards.isEmpty && openApprovals.isEmpty
                && sudoApprovals.isEmpty
            {
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
                        .readableTranscriptColumn()

                    ForEach(group.messages) { message in
                        MessageBubble(
                            message: message,
                            onInlineSprinkleLick: onInlineSprinkleLick,
                            toolProgress: toolProgress
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
                        .readableTranscriptColumn()
                    }
                }

                // Approval placeholders sit after the transcript, matching
                // the leader mounting them outside the message list.
                ForEach(toolUICards) { card in
                    ToolUICardView(card: card)
                        .padding(.horizontal, 12)
                        .readableTranscriptColumn()
                }

                ForEach(openApprovals) { request in
                    OpenApprovalCard(request: request) { decision in
                        onOpenApprovalDecision?(request.requestId, decision)
                    }
                    .padding(.horizontal, 12)
                    .readableTranscriptColumn()
                }

                ForEach(sudoApprovals) { request in
                    SudoApprovalCard(request: request, allowAlways: sudoAllowAlways) { decision in
                        onSudoApprovalDecision?(request.requestId, decision)
                    }
                    .padding(.horizontal, 12)
                    .readableTranscriptColumn()
                }

                // Invisible anchor at bottom. Its greedy width is load-bearing:
                // the rows are centered by this stack's `.center` alignment,
                // which can only center them if the stack itself spans the
                // whole viewport rather than hugging the capped rows.
                Color.clear
                    .frame(maxWidth: .infinity, minHeight: 1, maxHeight: 1)
                    .id("bottom")
            }
            // Stays directly on the stack so every message remains its own
            // scroll target for `scrollTo(id:)`. Nothing may wrap it in a
            // sizing frame — see `readableTranscriptColumn()`.
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
        .onChange(of: openApprovals.count) { _, _ in
            scrollToBottom()
        }
        .onChange(of: sudoApprovals.count) { _, _ in
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
