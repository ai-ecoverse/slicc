import SliccTrayKit
import SwiftUI







struct ThreadListColumn: View {
    let presentation: ThreadListPresentation
    
    
    var picksEnabled = true
    
    var edge: HorizontalEdge = .leading
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var threadList: ThreadListModel
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var rows: [ThreadListRow] {
        ThreadListRow.rows(
            scoops: appState.scoops,
            selectedJid: appState.selectedScoopJid,
            leaderActiveJid: appState.leaderActiveScoopJid,
            unread: threadList.unread,
            local: appState.localExpressionSignals)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(rows) { row in
                        Button {
                            guard picksEnabled else { return }
                            appState.selectScoop(jid: row.jid)
                            withAnimation(ThreadListMotion.animation(reduceMotion: reduceMotion)) {
                                threadList.didSelect(in: presentation)
                            }
                        } label: {
                            ThreadListRowView(row: row)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(row.accessibilityLabel)
                        .accessibilityAddTraits(row.isSelected ? .isSelected : [])
                        .accessibilityIdentifier("scoop-switch-\(row.jid)")
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 12)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(palette.surface.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-list")
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Threads")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(palette.inkSecondary)
                .textCase(.uppercase)
            Spacer(minLength: 0)
            Button {
                withAnimation(ThreadListMotion.animation(reduceMotion: reduceMotion)) {
                    threadList.dismiss(in: presentation)
                }
            } label: {
                Image(systemName: ThreadListLayout.dismissGlyph(presentation, onTrailingEdge: edge == .trailing))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(palette.ink.opacity(0.6))
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(presentation == .sidebar ? "Hide threads" : "Close threads")
            .accessibilityIdentifier("thread-list-close")
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .frame(height: 44)
    }
}






struct ThreadListRowView: View {
    let row: ThreadListRow
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            SliccAgentAvatarView(
                avatar: row.scoop.avatarGeometry(sideLength: 26, activity: row.activity),
                
                
                tiltSource: FixedSliccAgentAvatarTiltSource(
                    roll: 0, pitch: 0, isDeviceMotionAvailable: false),
                pupilOffset: .init(x: 0, y: 0)
            )
            .frame(width: 32, height: 32)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(row.label)
                        .font(.system(size: 15, weight: row.isSelected ? .semibold : .medium))
                        .foregroundStyle(palette.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if row.isReadOnly {
                        Image(systemName: "eye")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(palette.inkTertiary)
                    }
                }
                detailLine
            }
            Spacer(minLength: 4)
            trailingMarkers
        }
        .padding(.vertical, 6)
        .padding(.leading, 8 + CGFloat(min(row.depth, 4)) * 18)
        .padding(.trailing, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(row.isSelected ? palette.ink.opacity(0.08) : .clear)
        )
        .contentShape(Rectangle())
    }

    
    
    
    
    private var detailLine: some View {
        ViewThatFits(in: .horizontal) {
            if let model = row.modelId {
                Text("\(statusText) · \(model)")
                    .fixedSize(horizontal: true, vertical: false)
            }
            statusText
        }
        .font(.system(size: 12))
        .foregroundStyle(palette.inkSecondary)
        .lineLimit(1)
    }

    
    
    private var statusText: Text {
        var text = Text(row.role.rawValue)
        if let fill = row.fillText {
            let styled = Text(fill).foregroundStyle(
                row.status.isNearLimit ? Color.orange : palette.inkSecondary)
            text = Text("\(text) · \(styled)")
        }
        if let phrase = row.activityPhrase {
            let styled = Text(phrase).foregroundStyle(
                row.status.lifecycle == .broken ? Color.red : palette.inkSecondary)
            text = Text("\(text) · \(styled)")
        }
        return text
    }

    @ViewBuilder
    private var trailingMarkers: some View {
        HStack(spacing: 6) {
            if row.unread > 0 {
                Text(row.unread > 99 ? "99+" : "\(row.unread)")
                    .font(.system(size: 11, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(palette.canvas)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 18, minHeight: 18)
                    .background(Capsule().fill(palette.accent))
            }
            if row.isLeaderActive {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(palette.accent)
            }
        }
    }
}







struct ThreadListOverlay: View {
    let edge: HorizontalEdge
    let availableWidth: CGFloat
    @EnvironmentObject var threadList: ThreadListModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @GestureState private var dragOffset: CGFloat = 0
    @State private var dragging = false

    
    private static let dismissDistance: CGFloat = 72

    var body: some View {
        ZStack(alignment: edge == .leading ? .leading : .trailing) {
            if threadList.isOverlayOpen {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { close() }
                    .transition(.opacity)
                    .accessibilityElement()
                    .accessibilityLabel("Close threads")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { close() }
                    .accessibilityIdentifier("thread-list-scrim")
                ThreadListColumn(presentation: .overlay, picksEnabled: !dragging)
                    .frame(width: ThreadListLayout.overlayWidth(availableWidth: availableWidth))
                    .shadow(color: .black.opacity(0.18), radius: 16)
                    .offset(x: dragOffset)
                    .simultaneousGesture(dismissDrag)
                    .transition(reduceMotion ? .opacity : .move(edge: edge == .leading ? .leading : .trailing))
                    .accessibilityAddTraits(.isModal)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: edge == .leading ? .leading : .trailing)
    }

    
    
    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($dragOffset) { value, state, _ in
                state = towardEdge(value.translation)
            }
            .onChanged { value in
                if towardEdge(value.translation) != 0 { dragging = true }
            }
            .onEnded { value in
                
                
                Task { @MainActor in dragging = false }
                let moved = abs(towardEdge(value.translation))
                let flung = abs(towardEdge(value.predictedEndTranslation))
                if moved > Self.dismissDistance || flung > Self.dismissDistance * 2 {
                    close()
                }
            }
    }

    private func towardEdge(_ translation: CGSize) -> CGFloat {
        guard abs(translation.width) > abs(translation.height) else { return 0 }
        return edge == .leading ? min(0, translation.width) : max(0, translation.width)
    }

    private func close() {
        withAnimation(ThreadListMotion.animation(reduceMotion: reduceMotion)) {
            threadList.isOverlayOpen = false
        }
    }
}





struct ThreadListSidebar: View {
    let edge: HorizontalEdge

    var body: some View {
        HStack(spacing: 0) {
            if edge == .trailing { Divider() }
            ThreadListColumn(presentation: .sidebar, edge: edge)
                .frame(width: ThreadListLayout.sidebarWidth)
            if edge == .leading { Divider() }
        }
        .transition(.move(edge: edge == .leading ? .leading : .trailing))
    }
}
