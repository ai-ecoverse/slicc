import SwiftUI

/// The workbench surface presented over the chat — the native analogue of
/// the webapp's narrow-viewport full-bleed overlay (`slicc-shell.ts`
/// ≤560px: `position: absolute; right: 48px; z-index: 5`), leaving only
/// the dock rail beside it. Real views where the follower has one
/// (browser tabs, sprinkles); an honest placeholder everywhere the
/// surface lives on the leader — much better than a missing tab.
struct WorkbenchHost: View {
    let surface: DockSurface

    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            switch surface {
            case .browser:
                TabsCarouselView()
            case .sprinkle(let name):
                if let sprinkle = appState.sprinkles.first(where: { $0.name == name }) {
                    SprinkleDetailView(sprinkle: sprinkle)
                } else {
                    // The leader unregistered it while open.
                    placeholder("This sprinkle is no longer registered on the leader.")
                }
            case .newSprinkle, .files, .term, .memory, .monitor:
                placeholder(DockModel.placeholderText(for: surface) ?? "")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.canvas)
    }

    @ViewBuilder
    private func placeholder(_ text: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 32))
                .foregroundStyle(palette.inkTertiary)
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(palette.inkSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("workbench-placeholder")
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
