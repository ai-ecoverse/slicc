import SwiftUI

struct ConnectionStatusView: View {
    let state: ConnectionState
    /// In-flight reconnect attempt, 1-based. Zero renders no attempt count.
    var reconnectAttempt: Int = 0
    /// Leader stopped answering pings but its channel is still open.
    var isStalled: Bool = false
    var onTapDisconnected: (() -> Void)?

    /// A stall is only meaningful on an otherwise healthy connection; once the
    /// state itself is degraded, that state is the more specific news.
    private var showsStall: Bool { isStalled && state == .connected }

    private var dotColor: Color {
        if showsStall { return .orange }
        switch state {
        case .connected: return .green
        case .connecting: return .yellow
        case .reconnecting: return .orange
        case .disconnected, .failed, .gaveUp: return .red
        }
    }

    private var statusText: String? {
        if showsStall { return "The leader is busy — hang on…" }
        switch state {
        case .connected: return nil
        case .connecting: return "Connecting…"
        case .reconnecting:
            // Attempt feedback distinguishes a transient blip that is actively
            // being retried from a connection that is merely hung.
            return reconnectAttempt > 0
                ? "Reconnecting… (\(reconnectAttempt)/\(ReconnectBackoff.maxAttempts))"
                : "Reconnecting…"
        case .disconnected: return "Disconnected"
        case .failed: return "Connection Failed"
        case .gaveUp: return "Couldn't reach the leader. Reload to retry."
        }
    }

    private var showBanner: Bool {
        state != .connected || showsStall
    }

    var body: some View {
        if showBanner {
            HStack(spacing: 6) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 8, height: 8)

                if let text = statusText {
                    Text(text)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.85))
                        .accessibilityIdentifier("connection-status")
                }

                if state == .connecting {
                    ProgressView()
                        .scaleEffect(0.6)
                        .tint(.yellow)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                Capsule()
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        Capsule()
                            .stroke(dotColor.opacity(0.3), lineWidth: 0.5)
                    )
            )
            .animation(
                state == .connecting
                    ? .easeInOut(duration: 1.0).repeatForever(autoreverses: true)
                    : .default,
                value: state == .connecting
            )
            .onTapGesture {
                // `.gaveUp` is terminal but actionable — tapping is the retry.
                if state == .disconnected || state == .failed || state == .gaveUp {
                    onTapDisconnected?()
                }
            }
            .padding(.top, 4)
            .padding(.bottom, 2)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
        // Connected: render nothing. The presence of chat content
        // already signals connectivity; a stray green dot in its own
        // VStack row floats unattached and visually overlaps the first
        // chat message. Only surface the banner when something needs
        // the user's attention.
    }
}

// MARK: - Preview

#Preview("Connected") {
    ZStack {
        Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255).ignoresSafeArea()
        VStack {
            ConnectionStatusView(state: .connected)
            Spacer()
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("Connecting") {
    ZStack {
        Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255).ignoresSafeArea()
        VStack {
            ConnectionStatusView(state: .connecting)
            Spacer()
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("Disconnected") {
    ZStack {
        Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255).ignoresSafeArea()
        VStack {
            ConnectionStatusView(state: .disconnected)
            Spacer()
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("Failed") {
    ZStack {
        Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255).ignoresSafeArea()
        VStack {
            ConnectionStatusView(state: .failed)
            Spacer()
        }
    }
    .preferredColorScheme(.dark)
}
