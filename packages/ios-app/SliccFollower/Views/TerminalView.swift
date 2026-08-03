import GhosttyTerminal
import SwiftUI

struct TerminalView: View {
    @StateObject private var model: TerminalViewModel
    let connectionAvailable: Bool
    let theme: SliccTheme?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.palette) private var palette

    init(
        client: TerminalClient,
        connectionAvailable: Bool,
        theme: SliccTheme?
    ) {
        self.connectionAvailable = connectionAvailable
        self.theme = theme
        #if DEBUG
            _model = StateObject(
                wrappedValue: TerminalViewModel(
                    client: client, fixtureEnabled: UITestHooks.terminalFixtureEnabled))
        #else
            _model = StateObject(wrappedValue: TerminalViewModel(client: client))
        #endif
    }

    var body: some View {
        VStack(spacing: 0) {
            if model.isRunning {
                runningBar
            }
            ZStack {
                TerminalSurfaceView(context: model.terminal)
                    .accessibilityLabel("Terminal")
                    .accessibilityIdentifier("terminal-surface")
                    .accessibilityValue(model.accessibilityTranscript)
                    .allowsHitTesting(connectionAvailable)

                Text(model.accessibilityTranscript)
                    .font(.system(size: 1))
                    .lineLimit(1)
                    .foregroundStyle(Color.clear)
                    .frame(width: 1, height: 1)
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("terminal-transcript")

                if !connectionAvailable {
                    disconnectedPlaceholder
                }
            }
        }
        .background(palette.canvas)
        .task {
            await model.start()
        }
        .onAppear { synchronizeModel() }
        .onChange(of: connectionAvailable) { model.setConnectionAvailable($0) }
        .onChange(of: theme) { model.applyTheme($0, systemScheme: colorScheme) }
        .onChange(of: colorScheme) { model.applyTheme(theme, systemScheme: $0) }
    }

    private var runningBar: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Command running")
                .font(.caption)
                .foregroundStyle(palette.inkSecondary)
            Spacer()
            Button("Ctrl-C") { model.interrupt() }
                .font(.caption.weight(.semibold))
                .accessibilityIdentifier("terminal-cancel")
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(palette.surface)
    }

    private var disconnectedPlaceholder: some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 32))
                .foregroundStyle(palette.inkTertiary)
            Text("Connect to a leader to use Terminal.")
                .font(.system(size: 14))
                .foregroundStyle(palette.inkSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("terminal-disconnected")
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.canvas.opacity(0.97))
    }

    private func synchronizeModel() {
        model.setConnectionAvailable(connectionAvailable)
        model.applyTheme(theme, systemScheme: colorScheme)
    }
}
