import SwiftUI

struct ConnectionStatusView: View {
    let state: ConnectionState
    var onTapDisconnected: (() -> Void)?

    private var dotColor: Color {
        switch state {
        case .connected: .green
        case .connecting: .yellow
        case .reconnecting: .orange
        case .disconnected, .failed: .red
        }
    }

    private var statusText: String? {
        switch state {
        case .connected: nil
        case .connecting: "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .disconnected: "Disconnected"
        case .failed: "Connection Failed"
        }
    }

    private var showBanner: Bool {
        state != .connected
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
            .opacity(state == .connecting ? 1.0 : 1.0)
            .animation(
                state == .connecting
                    ? .easeInOut(duration: 1.0).repeatForever(autoreverses: true)
                    : .default,
                value: state == .connecting
            )
            .onTapGesture {
                if state == .disconnected || state == .failed {
                    onTapDisconnected?()
                }
            }
            .padding(.top, 4)
            .padding(.bottom, 2)
            .transition(.move(edge: .top).combined(with: .opacity))
        } else {
            // Connected: minimal green dot
            HStack {
                Circle()
                    .fill(Color.green)
                    .frame(width: 6, height: 6)
            }
            .padding(.top, 2)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
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

