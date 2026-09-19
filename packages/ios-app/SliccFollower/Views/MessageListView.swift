import SliccTrayKit
import SwiftUI



enum MessageListLayout {
    
    
    static let maximumReadableWidth: CGFloat = 680
}

extension View {
    
    
    
    
    
    
    
    
    
    
    fileprivate func readableTranscriptColumn() -> some View {
        frame(maxWidth: MessageListLayout.maximumReadableWidth)
    }
}


struct MessageListView: View {
    let messages: [ChatMessage]
    let isStreaming: Bool
    
    
    var toolProgress: [String: ToolProgressEvent] = [:]
    
    var toolUICards: [ToolUIPlaceholder] = []
    
    var openApprovals: [OpenApprovalRequest] = []
    var onOpenApprovalDecision: ((String, OpenApprovalDecision) -> Void)?
    
    var sudoApprovals: [SudoApprovalRequest] = []
    var sudoAllowAlways = false
    var onSudoApprovalDecision: ((String, SudoApprovalDecision) -> Void)?
    
    
    
    var onInlineSprinkleLick: ((AnyCodable?, String?) -> Void)?
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
        onInlineSprinkleLick: ((AnyCodable?, String?) -> Void)? = nil
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
    }

    @Environment(\.palette) private var palette

    
    
    
    
    @State private var isAtBottom = true

    
    
    
    
    
    @State private var wasFollowingBeforeKeyboard = false

    var body: some View {
        
        
        
        ZStack {
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

    

    private var messageList: some View {
        ScrollViewReader { proxy in
            transcriptScrollView(proxy: proxy)
        }
    }

    private func transcriptScrollView(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(groupedMessages) { group in
                    
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
                        
                        
                        
                        
                        .equatable()
                        .id(message.id)
                        .padding(.horizontal, 12)
                        
                        
                        
                        
                        
                        
                        .accessibilityIdentifier("message-\(message.id)")
                        .readableTranscriptColumn()
                    }
                }

                
                
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

                
                
                
                
                Color.clear
                    .frame(maxWidth: .infinity, minHeight: 1, maxHeight: 1)
                    .id(Self.bottomAnchorId)
            }
            
            
            
            .scrollTargetLayout()
            .padding(.vertical, 8)
        }
        
        
        
        
        
        
        
        
        
        .onScrollTargetVisibilityChange(idType: String.self) { visible in
            
            
            
            
            
            
            
            
            isAtBottom = messages.last.map { visible.contains($0.id) } ?? true
        }
        
        
        
        
        .onChange(of: messages.count) { _, _ in
            followBottom(proxy, force: messages.last?.role == .user)
        }
        .onChange(of: messages.last?.content) { _, _ in followBottom(proxy) }
        .onChange(of: toolUICards.count) { _, _ in followBottom(proxy) }
        .onChange(of: openApprovals.count) { _, _ in followBottom(proxy) }
        .onChange(of: sudoApprovals.count) { _, _ in followBottom(proxy) }
        
        
        
        
        
        
        .onReceive(Self.keyboardWillShow) { _ in wasFollowingBeforeKeyboard = isAtBottom }
        .onReceive(Self.keyboardDidShow) { _ in
            followBottom(proxy, force: wasFollowingBeforeKeyboard)
        }
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .alignment)
        
        
        .scrollEdgeEffectStyle(.soft, for: .vertical)
    }

    
    
    
    
    
    
    
    
    private func followBottom(_ proxy: ScrollViewProxy, force: Bool = false) {
        guard force || isAtBottom else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(Self.bottomAnchorId, anchor: .bottom)
        }
    }

    
    
    
    
    
    
    
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
        
        
        func progressSliceForTesting(_ message: ChatMessage) -> [String: ToolProgressEvent] {
            progressSlice(for: message)
        }
    #endif

    

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

    private static let keyboardWillShow = NotificationCenter.default.publisher(
        for: UIResponder.keyboardWillShowNotification)
    private static let keyboardDidShow = NotificationCenter.default.publisher(
        for: UIResponder.keyboardDidShowNotification)

    
    
    private static let bottomAnchorId = "bottom"

    
    
    
    
    
    
    
    
    
    
    
    
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



private struct MessageGroup: Identifiable {
    let id: String
    let label: String
    var messages: [ChatMessage]
}



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
        isStreaming: false
    )
}
