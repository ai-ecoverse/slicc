import SliccTrayKit
import SwiftUI
import UIKit







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


enum ThreadListMotion {
    static func animation(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .snappy(duration: 0.28)
    }
}







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
