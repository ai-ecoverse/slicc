import SliccTrayKit
import SwiftUI





struct WorkbenchHost: View {
    let surface: DockSurface
    
    
    
    var isActive: Bool = true
    
    
    
    
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
