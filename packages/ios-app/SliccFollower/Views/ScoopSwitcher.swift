import SliccTrayKit
import SwiftUI
import UIKit

// MARK: - ScoopSwitcher

/// The nav-bar cone/scoop switcher: the selected unit's label in a
/// nav-bar-sized pill. With more than one unit it opens the thread list
/// (`ThreadListColumn`) — sliding it over the conversation at compact width,
/// folding the sidebar in and out at regular width. Swipe still cycles.
struct ScoopSwitcher: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var threadList: ThreadListModel
    @Environment(\.palette) private var palette
    @Environment(\.threadListPresentation) private var presentation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if appState.scoops.count > 1 {
            Button {
                if presentation == .overlay, !threadList.isOverlayOpen {
                    // The slide-over covers the composer; a keyboard left up
                    // underneath it would reappear over nothing on dismiss.
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder),
                        to: nil, from: nil, for: nil)
                }
                withAnimation(ThreadListMotion.animation(reduceMotion: reduceMotion)) {
                    threadList.toggle(in: presentation)
                }
            } label: {
                identityLabel
            }
            .buttonStyle(.plain)
            .accessibilityLabel(appState.selectedScoop?.assistantLabel ?? "Sliccy")
            .accessibilityHint(toggleHint)
            .accessibilityIdentifier("scoop-switcher")
            // The header names the conversation on screen, which is what
            // "this conversation" refers to.
            .sliccEntityAnnotation(SliccConversationEntity.self, id: appState.selectedScoopJid)
        } else {
            identityLabel
                .accessibilityLabel(appState.selectedScoop?.assistantLabel ?? "Sliccy")
                .accessibilityIdentifier("scoop-switcher")
                .sliccEntityAnnotation(
                    SliccConversationEntity.self, id: appState.selectedScoopJid)
        }
    }

    private var toggleHint: String {
        threadList.isVisible(in: presentation) ? "Hide threads" : "Show threads"
    }

    /// The pill's face: label + chevron. The label sizes to its own text up
    /// to 120pt and truncates past it, whatever width the toolbar proposes —
    /// a toolbar `Button` proposes one small enough to squeeze a flexible
    /// frame to nothing, where the old `Menu` label never was.
    private var identityLabel: some View {
        HStack(spacing: 5) {
            CappedWidth(cap: 120) {
                Text(appState.selectedScoop?.assistantLabel ?? "Sliccy")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if appState.scoops.count > 1 {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(palette.ink.opacity(0.5))
                    .rotationEffect(.degrees(threadList.isVisible(in: presentation) ? 180 : 0))
            }
        }
        .contentShape(Rectangle())
    }
}

/// Lays its content out at its natural width, never wider than `cap`,
/// independent of the proposal.
private struct CappedWidth: Layout {
    let cap: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(ProposedViewSize(width: cap, height: proposal.height))
            ?? .zero
    }

    func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) {
        subviews.first?.place(
            at: bounds.origin,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// One motion for every way the thread list opens and closes.
enum ThreadListMotion {
    static func animation(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .snappy(duration: 0.28)
    }
}

// MARK: - ScoopStatusAvatar

/// A unit's avatar with its lifecycle and fill spoken for VoiceOver. Fullness
/// is already encoded in the pupil size. The header's copy keeps the
/// `scoop-avatar` identifier UI tests look it up by; thread-list rows fold
/// theirs into the row's own label instead.
struct ScoopStatusAvatar: View {
    let avatar: SliccAgentAvatarGeometry
    let accessibilityLabel: String
    var expression: AvatarExpressionEngine?

    var body: some View {
        ZStack {
            SliccAgentAvatarView(avatar: avatar, expression: expression)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier("scoop-avatar")
    }
}
