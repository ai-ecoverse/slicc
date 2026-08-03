import GhosttyTerminal
import SwiftUI
import UIKit

struct TerminalView: View {
    @StateObject private var model: TerminalViewModel
    let connectionAvailable: Bool
    /// False while the terminal stays mounted behind another surface. The
    /// view cannot be torn down (that would take the scrollback with it), so
    /// everything it vends has to be withdrawn from assistive tech by hand:
    /// SwiftUI's `.accessibilityHidden` on an ancestor does not reach into
    /// the Ghostty `UIViewRepresentable`, leaving a phantom terminal that
    /// VoiceOver can still swipe into from the chat.
    let isActive: Bool
    let theme: SliccTheme?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.palette) private var palette

    init(
        client: TerminalClient,
        connectionAvailable: Bool,
        isActive: Bool,
        theme: SliccTheme?
    ) {
        self.connectionAvailable = connectionAvailable
        self.isActive = isActive
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
            if Self.shouldShowRunningBar(
                isRunning: model.isRunning,
                connectionAvailable: connectionAvailable,
                isActive: isActive
            ) {
                runningBar
            }
            ZStack {
                AccessibleTerminalSurfaceView(
                    context: model.terminal,
                    isAccessible: Self.shouldExposeTerminalAccessibility(
                        connectionAvailable: connectionAvailable,
                        isActive: isActive),
                    transcript: model.accessibilityTranscript
                )
                .allowsHitTesting(connectionAvailable && isActive)

                if connectionAvailable && isActive {
                    Text(model.accessibilityTranscript)
                        .font(.system(size: 1))
                        .lineLimit(1)
                        .foregroundStyle(Color.clear)
                        .frame(width: 1, height: 1)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                        .accessibilityIdentifier("terminal-transcript")
                }

                // Unlike the surface, the placeholder holds no state worth
                // preserving, so it is not rendered at all while collapsed.
                if !connectionAvailable && isActive {
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

    static func shouldShowRunningBar(
        isRunning: Bool,
        connectionAvailable: Bool,
        isActive: Bool
    ) -> Bool {
        isRunning && connectionAvailable && isActive
    }

    static func shouldExposeTerminalAccessibility(
        connectionAvailable: Bool,
        isActive: Bool
    ) -> Bool {
        connectionAvailable && isActive
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

private struct AccessibleTerminalSurfaceView: UIViewRepresentable {
    let context: TerminalViewState
    let isAccessible: Bool
    let transcript: String

    func makeUIView(context _: Context) -> GhosttyTerminal.TerminalView {
        let view = GhosttyTerminal.TerminalView(frame: .zero)
        view.delegate = context
        view.controller = context.controller
        view.configuration = context.configuration
        configureAccessibility(view)
        return view
    }

    func updateUIView(_ view: GhosttyTerminal.TerminalView, context _: Context) {
        configureAccessibility(view)
    }

    private func configureAccessibility(_ view: GhosttyTerminal.TerminalView) {
        view.isAccessibilityElement = isAccessible
        view.accessibilityElementsHidden = !isAccessible
        view.accessibilityLabel = isAccessible ? "Terminal" : nil
        view.accessibilityIdentifier = isAccessible ? "terminal-surface" : nil
        view.accessibilityValue = isAccessible ? transcript : nil
    }
}
