import GhosttyTerminal
import SwiftUI
import UIKit

struct TerminalView: View {
    enum UnavailableState: Equatable {
        case disconnected
        case unsupported

        var message: String {
            switch self {
            case .disconnected:
                return "Connect to a leader to use Terminal."
            case .unsupported:
                return "This leader does not support Terminal. Upgrade the leader to enable terminal execution."
            }
        }

        var accessibilityIdentifier: String {
            switch self {
            case .disconnected: return "terminal-disconnected"
            case .unsupported: return "terminal-unsupported"
            }
        }
    }

    @ObservedObject private var model: TerminalViewModel
    let connectionAvailable: Bool

    let transportConnected: Bool

    let isActive: Bool
    let theme: SliccTheme?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.palette) private var palette

    init(
        model: TerminalViewModel,
        connectionAvailable: Bool,
        transportConnected: Bool,
        isActive: Bool,
        theme: SliccTheme?
    ) {
        _model = ObservedObject(wrappedValue: model)
        self.connectionAvailable = connectionAvailable
        self.transportConnected = transportConnected
        self.isActive = isActive
        self.theme = theme
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

                if !connectionAvailable && isActive {
                    unavailablePlaceholder(Self.unavailableState(transportConnected: transportConnected))
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

    static func unavailableState(transportConnected: Bool) -> UnavailableState {
        transportConnected ? .unsupported : .disconnected
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

    private func unavailablePlaceholder(_ state: UnavailableState) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 32))
                .foregroundStyle(palette.inkTertiary)
            Text(state.message)
                .font(.system(size: 14))
                .foregroundStyle(palette.inkSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier(state.accessibilityIdentifier)
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
