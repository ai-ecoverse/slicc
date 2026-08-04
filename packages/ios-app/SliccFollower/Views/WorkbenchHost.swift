import SwiftUI

/// The selected workbench surface. ChatView presents it over the conversation
/// at compact width and beside the conversation at regular width. Real views
/// appear where the follower has one (browser tabs, sprinkles); an honest
/// placeholder appears everywhere the surface lives on the leader.
struct WorkbenchHost: View {
    let surface: DockSurface
    /// Only `.term` outlives its presentation (see `TerminalView.isActive`);
    /// every other surface is torn down on collapse, so they default to
    /// active and never observe this.
    var isActive: Bool = true
    /// Supplied only for `.term`, and owned by the shell rather than by this
    /// host: both adaptive layouts hand over the same model, so resizing
    /// across the size-class boundary re-parents the terminal instead of
    /// rebuilding it. Other surfaces leave it nil and never read it.
    var terminalModel: TerminalViewModel?

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
            case .monitor:
                MonitorView()
            case .memory:
                MemoryView()
            case .files:
                FilesView()
            case .term:
                if let terminalModel {
                    TerminalView(
                        model: terminalModel,
                        connectionAvailable: Self.terminalConnectionAvailable(
                            connectionState: appState.connectionState,
                            isLeaderStalled: appState.isLeaderStalled,
                            leaderCapabilities: terminalLeaderCapabilities),
                        transportConnected: appState.connectionState == .connected,
                        isActive: isActive,
                        theme: appState.leaderTheme
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.canvas)
    }

    static func terminalConnectionAvailable(
        connectionState: ConnectionState,
        isLeaderStalled _: Bool,
        leaderCapabilities: TraySyncCapabilities?
    ) -> Bool {
        connectionState == .connected && leaderCapabilities?.exec == true
    }

    private var terminalLeaderCapabilities: TraySyncCapabilities? {
        #if DEBUG
            if UITestHooks.terminalFixtureEnabled {
                return TraySyncCapabilities(exec: true)
            }
        #endif
        return appState.leaderCapabilities
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
