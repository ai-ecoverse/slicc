import SliccTrayKit
import SwiftUI
import UIKit

// MARK: - ThreadListColumn

/// Every cone and scoop the leader runs, scoops nested under the cone that
/// owns them (`ThreadListOrder`). The same column serves both shapes: the
/// compact slide-over and the regular sidebar. Selection goes through
/// `AppState.selectScoop(jid:)` and nothing else.
struct ThreadListColumn: View {
    let presentation: ThreadListPresentation
    /// False while the slide-over is being dragged away: the touch that
    /// started on a row lifts over it, and a dismissal must not be a pick.
    var picksEnabled = true
    /// The side the column sits on, so the fold glyph points at its own edge.
    var edge: HorizontalEdge = .leading
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var threadList: ThreadListModel
    @EnvironmentObject var summaries: ThreadSummaryStore
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
                            ThreadListRowView(row: row, summary: summaries.lines[row.jid])
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(row.accessibilityLabel)
                        .accessibilityValue(summaries.lines[row.jid] ?? "")
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
        // Summaries are made only while the list is on screen, and refreshed
        // on the two things that move a transcript's tail: a roster push (a
        // unit finished a turn) and the viewed thread's newest row.
        .onAppear { summaries.refresh(buffers: appState.messagesByScoop) }
        .onDisappear { summaries.suspend() }
        .onChange(of: appState.scoops) { _, _ in
            summaries.refresh(buffers: appState.messagesByScoop)
        }
        .onChange(of: appState.messages.last?.id) { _, _ in
            summaries.refresh(buffers: appState.messagesByScoop)
        }
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

// MARK: - ThreadListRowView

/// Line heights pinned to the fonts the row actually draws. A summary that
/// arrives later — or a shorter on-device line replacing the preview — must
/// not change either number, or the rows under it jump.
private enum ThreadListRowMetrics {
    static let labelHeight = UIFont.systemFont(ofSize: 15, weight: .semibold).lineHeight
    static let summaryHeight = UIFont.systemFont(ofSize: 12).lineHeight
}

/// One unit: the real status avatar, its label, and one line saying what the
/// thread is about. State, fill and cone-vs-scoop are NOT spelled out: the
/// avatar's eyes, pupils and hue already say them, and the indent says who
/// owns whom. VoiceOver still gets all of it through the row's label.
struct ThreadListRowView: View {
    let row: ThreadListRow
    /// What the thread is about — see `ThreadSummaryStore`. Absent until the
    /// unit's transcript has been seen this session. The slot is reserved
    /// either way: inserting the line, or swapping the preview for the model's
    /// words, must not move this row or the ones below it.
    var summary: String?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            SliccAgentAvatarView(
                avatar: row.scoop.avatarGeometry(sideLength: 26, activity: row.activity),
                // Rows never follow the device tilt: one motion manager per
                // row buys nothing a still pupil does not already say.
                tiltSource: FixedSliccAgentAvatarTiltSource(
                    roll: 0, pitch: 0, isDeviceMotionAvailable: false),
                pupilOffset: .init(x: 0, y: 0)
            )
            .frame(width: 32, height: 32)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.label)
                    .font(.system(size: 15, weight: row.isSelected ? .semibold : .medium))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: ThreadListRowMetrics.labelHeight, alignment: .leading)
                // Always in the tree. A conditional `Text` is a structural
                // insert, and that insert is what shifts the list when the
                // model finally answers.
                Text(summary ?? "")
                    .font(.system(size: 12))
                    .foregroundStyle(palette.inkSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: ThreadListRowMetrics.summaryHeight, alignment: .leading)
                    .opacity(summary == nil ? 0 : 1)
                    .accessibilityIdentifier("thread-summary-\(row.jid)")
                    .accessibilityHidden(summary == nil)
                    .contentTransition(.identity)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailingMarkers
        }
        .padding(.vertical, 6)
        .padding(.leading, 8 + CGFloat(min(row.depth, 4)) * 18)
        .padding(.trailing, 10)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(row.isSelected ? palette.ink.opacity(0.08) : .clear)
        )
        .contentShape(Rectangle())
        // The swap is a string replacement, not a resize. An inherited
        // animation would interpolate the row's frame across it.
        .animation(nil, value: summary)
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

// MARK: - ThreadListOverlay

/// The compact shape: the column slides in from the switcher's edge over a
/// scrim. It sits ABOVE the conversation, so while it is open no touch reaches
/// the transcript's swipe arbitration or the dock rail beneath it; a tap on
/// the scrim or a drag toward the edge dismisses.
struct ThreadListOverlay: View {
    let edge: HorizontalEdge
    let availableWidth: CGFloat
    @EnvironmentObject var threadList: ThreadListModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @GestureState private var dragOffset: CGFloat = 0
    @State private var dragging = false

    /// Past this, or flung past twice this, a drag dismisses.
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

    /// Only a mostly-horizontal drag toward the edge moves the panel, so the
    /// column's own vertical scroll keeps working underneath.
    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($dragOffset) { value, state, _ in
                state = towardEdge(value.translation)
            }
            .onChanged { value in
                if towardEdge(value.translation) != 0 { dragging = true }
            }
            .onEnded { value in
                // Released on the next turn, after the row's touch-up has
                // been turned away.
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

// MARK: - ThreadListSidebar

/// The regular shape: a persistent column beside the conversation, on the
/// switcher's side. Collapsing folds it away; the pill brings it back.
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
