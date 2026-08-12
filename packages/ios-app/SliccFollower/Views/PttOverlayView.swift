import SwiftUI
import UIKit

// MARK: - Overlay

/// The push-to-talk overlay that turns the composer band into one big
/// walkie-talkie button while a hold is active. Renders whatever stage the
/// `PttController` is in; it never owns state. Ported from the
/// `.slicc-composer__ptt` overlay stages (web parity), minus the mic picker
/// — iOS routes the input device at the system level.
struct PttOverlayView: View {
    let stage: PttStage
    let caption: String
    let captionIsError: Bool
    /// The engine's "where does my audio go" disclosure line.
    let statusLine: String

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 6) {
            switch stage {
            case .idle:
                EmptyView()
            case .enable:
                micIcon(pulse: false)
                Text("Hold to enable push to talk")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(palette.ink)
                sweepBar
                Text("Requesting microphone access when the bar fills")
                    .font(.caption2)
                    .foregroundStyle(palette.inkSecondary)
            case .prompting:
                micIcon(pulse: false)
                Text("Allow microphone access")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(palette.ink)
                Text("Waiting for permission…")
                    .font(.caption2)
                    .foregroundStyle(palette.inkSecondary)
            case .denied(let message):
                Image(systemName: "mic.slash.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(.red)
                Text(message == nil ? "Microphone access is blocked" : "Push to talk unavailable")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(palette.ink)
                Text(
                    message
                        ?? "Enable the microphone and speech recognition for Sliccy in Settings, then hold again."
                )
                .font(.caption2)
                .foregroundStyle(palette.inkSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("ptt-denied")
            case .recording:
                micIcon(pulse: true)
                Text(caption.isEmpty ? "Listening…" : caption)
                    .font(.subheadline)
                    .foregroundStyle(captionIsError ? .red : palette.ink)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .accessibilityIdentifier("ptt-caption")
                Text(statusLine)
                    .font(.caption2)
                    .foregroundStyle(palette.inkSecondary)
                    .accessibilityIdentifier("ptt-status")
            case .finalizing:
                ProgressView()
                    .tint(palette.accent)
                Text("Transcribing…")
                    .font(.subheadline)
                    .foregroundStyle(palette.ink)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(palette.surface)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(palette.accent.opacity(0.6))
                .frame(height: 1)
        }
        // No container-level identifier: SwiftUI stamps one onto every leaf,
        // clobbering the per-leaf ids (`ptt-caption`, `ptt-denied`) tests
        // key on — the repo's documented put-ids-on-leaves gotcha.
    }

    @ViewBuilder
    private func micIcon(pulse: Bool) -> some View {
        PulsingMic(active: pulse, tint: palette.accent)
    }

    @ViewBuilder
    private var sweepBar: some View {
        EnableSweepBar(tint: palette.accent)
    }
}

/// The recording mic. Owns its pulse so the animation restarts whenever the
/// stage branch (re)mounts it. Reduce Motion keeps it lit but still (web
/// parity with `prefers-reduced-motion`).
private struct PulsingMic: View {
    let active: Bool
    let tint: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var up = false

    var body: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 24))
            .foregroundStyle(tint)
            .scaleEffect(active && up && !reduceMotion ? 1.25 : 1.0)
            .onAppear {
                guard active, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                    up = true
                }
            }
    }
}

/// The hold-to-enable progress bar, sweeping over
/// `PttController.holdToEnableMs` in step with the permission gate. Reduce
/// Motion renders it full immediately — the label carries the meaning.
private struct EnableSweepBar: View {
    let tint: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var filled = false

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.white.opacity(0.15))
                Capsule()
                    .fill(tint)
                    .frame(width: filled ? proxy.size.width : 0)
            }
        }
        .frame(height: 4)
        .padding(.horizontal, 32)
        .onAppear {
            guard !reduceMotion else {
                filled = true
                return
            }
            withAnimation(.linear(duration: Double(PttController.holdToEnableMs) / 1000)) {
                filled = true
            }
        }
    }
}

// MARK: - Press surface

/// Transparent touch surface laid over the empty composer field. SwiftUI
/// hit-testing is the only layer that can reliably sit above `TextEditor`'s
/// backing `UITextView` (a UIKit sibling always wins UIKit hit-testing, no
/// matter what order SwiftUI declares — which is also why the editor is
/// hit-disabled while this surface is armed). A zero-distance `DragGesture`
/// reports touch down/up; SwiftUI has no first-class touch-cancel, so the
/// host view cancels the press on scene-phase changes (the system-interrupt
/// case that would otherwise strand a recording).
struct PttPressSurface: View {
    let onDown: () -> Void
    let onUp: () -> Void

    @State private var pressing = false

    var body: some View {
        Color.clear
            .contentShape(Rectangle())
            .accessibilityIdentifier("ptt-surface")
            .accessibilityLabel("Message field — hold to talk")
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressing else { return }
                        pressing = true
                        onDown()
                    }
                    .onEnded { _ in
                        pressing = false
                        onUp()
                    }
            )
    }
}

// MARK: - Preview

#Preview("Recording") {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack {
            Spacer()
            PttOverlayView(
                stage: .recording,
                caption: "the quick brown fox jumps over",
                captionIsError: false,
                statusLine: "Transcribed on this device"
            )
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("Enable") {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack {
            Spacer()
            PttOverlayView(
                stage: .enable,
                caption: "",
                captionIsError: false,
                statusLine: ""
            )
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("Denied") {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack {
            Spacer()
            PttOverlayView(
                stage: .denied(message: nil),
                caption: "",
                captionIsError: false,
                statusLine: ""
            )
        }
    }
    .preferredColorScheme(.dark)
}
