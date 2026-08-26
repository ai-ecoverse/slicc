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
    /// Injected into the environment rather than handed to each row — see
    /// `MessageBubble`'s `Equatable` conformance.
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
        .environment(\.inlineSprinkleLick, onInlineSprinkleLick ?? { _, _ in })
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
                            toolProgress: progressSlice(for: message)
                        )
                        // Load-bearing: the `Equatable` conformance only takes
                        // effect through this modifier. Without it SwiftUI
                        // falls back to its own reflection-based comparison,
                        // which the environment-read properties defeat.
                        .equatable()
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

    /// The progress units belonging to ONE message's tool rows.
    ///
    /// Every row used to receive the entire `AppState.toolProgress`
    /// dictionary, so a single tick on a single tool changed every bubble's
    /// value and invalidated the whole transcript. Slicing it per row means an
    /// unchanged row keeps an equal value and SwiftUI can skip it. Rows with
    /// no tool calls get an empty dictionary, which is free.
    private func progressSlice(for message: ChatMessage) -> [String: ToolProgressEvent] {
        guard !toolProgress.isEmpty, let calls = message.toolCalls, !calls.isEmpty else {
            return [:]
        }
        var slice: [String: ToolProgressEvent] = [:]
        for call in calls {
            if let unit = toolProgress[call.id] { slice[call.id] = unit }
        }
        return slice
    }

    #if DEBUG
        /// Test seam for the per-row slice, which is otherwise private to the
        /// body-building path.
        func progressSliceForTesting(_ message: ChatMessage) -> [String: ToolProgressEvent] {
            progressSlice(for: message)
        }
    #endif

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

    /// Two shared formatters, built once.
    ///
    /// `groupedMessages` is recomputed on every body evaluation and calls this
    /// once per message, so a `DateFormatter()` per call meant N allocations
    /// per render — measured at 44 regroupings while scrolling back two
    /// screens, and 38 more while typing a single sentence. Constructing a
    /// `DateFormatter` is one of the more expensive things in Foundation.
    ///
    /// Safe to share: both are only read, never reconfigured, and the
    /// transcript renders on the main actor. The old code mutated one
    /// formatter's `dateStyle` mid-function, which is exactly why it could not
    /// be hoisted as-is.
    private static let timeOnlyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter
    }()

    private static let dateAndTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    static func timestampLabel(for date: Date, calendar: Calendar) -> String {
        if calendar.isDateInToday(date) {
            return "Today \(timeOnlyFormatter.string(from: date))"
        }
        if calendar.isDateInYesterday(date) {
            return "Yesterday \(timeOnlyFormatter.string(from: date))"
        }
        return dateAndTimeFormatter.string(from: date)
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
