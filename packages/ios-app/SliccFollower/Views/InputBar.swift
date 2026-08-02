import SwiftUI
import UIKit

struct InputBar: View {
    @Binding var text: String
    let isStreaming: Bool
    let isConnected: Bool
    /// Leader stopped answering pings while its channel stayed open. Sending is
    /// blocked, but this is not a disconnect and must not read as one.
    var isStalled: Bool = false
    /// A scoop-less `user_message` routes to the leader's ACTIVE scoop;
    /// when the follower is viewing a different one, the streaming-send /
    /// steer affordance hides so an interrupt cannot hit the wrong turn.
    var steersActiveScoop: Bool = true
    let onSend: (String) -> Void
    let onAbort: () -> Void
    /// Send interrupting the running turn (`user_message.steer`). Only
    /// reachable while streaming, via the long-press menu on send.
    var onSteer: (String) -> Void = { _ in }

    @FocusState private var isFocused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.palette) private var palette

    /// Push-to-talk: holding the EMPTY composer dictates a message
    /// (`PttController` owns the state machine; the engine is swappable so
    /// UI tests script it via `-uiTestSpeechPermission`).
    @StateObject private var ptt = PttController(engine: InputBar.makeDictationEngine())

    private var canSend: Bool {
        // Sending during a running turn queues on the leader (browser
        // parity); only an empty composer or an unusable connection blocks.
        isComposable && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Whether a message can be handed to the leader at all.
    private var isComposable: Bool { isConnected && !isStalled }

    private var placeholderText: String {
        if isStalled { return "The leader is busy — hang on…" }
        return isConnected ? "Message..." : "Disconnected"
    }

    var body: some View {
        VStack(spacing: 0) {
            // Top separator
            Rectangle()
                .fill(palette.line)
                .frame(height: 0.5)

            HStack(alignment: .bottom, spacing: 10) {
                // Text input area
                textField
                // Action button (send or abort)
                actionButton
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(palette.surface)
        .opacity(isComposable ? 1.0 : 0.5)
        .disabled(!isComposable)
        .animation(.easeInOut(duration: 0.2), value: isStreaming)
        .overlay {
            // The walkie-talkie overlay while a hold is active. Covers the
            // whole band so the held finger has nothing else to hit.
            if ptt.stage != .idle {
                PttOverlayView(
                    stage: ptt.stage,
                    caption: ptt.caption,
                    captionIsError: ptt.captionIsError,
                    statusLine: ptt.engineStatusLine
                )
            }
        }
        .onAppear {
            #if DEBUG
                if let forced = UITestHooks.pttStage() {
                    ptt.forceStage(forced.stage, caption: forced.caption)
                }
            #endif
        }
        // Handled from `.onChange` — NOT a callback stored at `onAppear` —
        // so the handler sees current props: an appear-time closure captures
        // the view value from before the connection state settled, and a
        // commit routed through that snapshot fails `isComposable` silently.
        .onChange(of: ptt.event) { _, event in
            guard let event else { return }
            switch event.kind {
            case .commit(let transcript):
                // The gesture only arms on an empty composer, so the
                // transcript IS the message — reuse the exact send path.
                text = transcript
                sendIfPossible()
            case .quickTap:
                // Restore the native behavior the surface intercepted: a
                // plain tap places the caret.
                isFocused = true
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // SwiftUI's DragGesture has no touch-cancel callback; a system
            // interrupt (incoming call, app switcher) surfaces as a scene
            // phase change instead, and a press must not outlive it.
            if phase != .active {
                ptt.pressCancelled()
            }
        }
        .onChange(of: pttArmed) { _, armed in
            // The surface unmounts the moment the composer disables (leader
            // stalled or disconnected mid-hold) — its onEnded then never
            // fires, so cancel here or the mic stays live behind a dead
            // composer.
            if !armed {
                ptt.pressCancelled()
            }
        }
    }

    // MARK: - Text Field

    @ViewBuilder
    private var textField: some View {
        ZStack(alignment: .topLeading) {
            // Placeholder
            if text.isEmpty {
                Text(placeholderText)
                    .foregroundColor(palette.inkSecondary)
                    .font(.system(size: 16))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("composer-placeholder")
            }

            TextEditor(text: $text)
                .font(.system(size: 16))
                .foregroundColor(palette.ink)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .frame(minHeight: 38, maxHeight: 100)
                .fixedSize(horizontal: false, vertical: true)
                .focused($isFocused)
                .onSubmit {
                    sendIfPossible()
                }
                // While push-to-talk is armed the UIKit text view must not
                // swallow touches: UITextView sits above any sibling overlay
                // in UIKit z-order no matter what SwiftUI declares, so the
                // press surface only ever hears a touch if the editor is
                // hit-disabled. There is nothing to lose — the composer is
                // empty (no caret to place, no text to select) and a quick
                // tap restores focus through the `quickTap` event.
                .allowsHitTesting(!pttArmed)
        }
        .background(palette.field)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(palette.ink.opacity(0.12), lineWidth: 0.5)
        )
        .overlay {
            // Hold-to-talk arms ONLY from an empty composer (web parity:
            // once text is present a press is editing it, so the surface
            // unmounts and selection/caret placement stay native). A quick
            // tap forwards to focus via the `quickTap` event.
            if pttArmed {
                PttPressSurface(
                    onDown: { ptt.pressDown() },
                    onUp: { ptt.pressUp() }
                )
            }
        }
    }

    /// The press surface mounts (and the editor yields its touches) only on
    /// an empty, usable composer.
    private var pttArmed: Bool { text.isEmpty && isComposable }

    /// The recognizer behind push-to-talk: a UI test's scripted fake when
    /// the launch arguments ask for one, Apple's on-device engine otherwise.
    private static func makeDictationEngine() -> DictationEngine {
        #if DEBUG
            if let scripted = UITestHooks.speechEngine() { return scripted }
        #endif
        return AppleDictationEngine()
    }

    // MARK: - Action Button

    @ViewBuilder
    private var actionButton: some View {
        if isStreaming {
            HStack(spacing: 6) {
                if canSend && steersActiveScoop {
                    // Tap queues behind the running turn; the long-press menu
                    // offers the interrupt — a discoverable, standard iOS
                    // idiom for the desktop's Cmd+Enter steer.
                    Menu {
                        Button(role: .destructive) {
                            steerIfPossible()
                        } label: {
                            Label("Interrupt & send", systemImage: "bolt.fill")
                        }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(palette.accent)
                    } primaryAction: {
                        sendIfPossible()
                    }
                    .accessibilityIdentifier("send-while-streaming")
                    .transition(.scale.combined(with: .opacity))
                }
                Button(action: onAbort) {
                    Image(systemName: "stop.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(.red)
                }
            }
            .transition(.scale.combined(with: .opacity))
            .padding(.bottom, 2)
        } else {
            Button(action: { sendIfPossible() }) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(canSend ? palette.accent : palette.inkTertiary.opacity(0.6))
            }
            .disabled(!canSend)
            .transition(.scale.combined(with: .opacity))
            .padding(.bottom, 2)
        }
    }

    // MARK: - Actions

    private func sendIfPossible() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, isComposable else { return }
        onSend(trimmed)
        text = ""
    }

    private func steerIfPossible() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, isComposable, isStreaming else { return }
        // Interrupting work in progress deserves a physical acknowledgment.
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onSteer(trimmed)
        text = ""
    }
}

// MARK: - Preview

#Preview("Connected") {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack {
            Spacer()
            InputBar(
                text: .constant(""),
                isStreaming: false,
                isConnected: true,
                onSend: { _ in },
                onAbort: {}
            )
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("Streaming") {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack {
            Spacer()
            InputBar(
                text: .constant("Hello world"),
                isStreaming: true,
                isConnected: true,
                onSend: { _ in },
                onAbort: {}
            )
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("Disconnected") {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack {
            Spacer()
            InputBar(
                text: .constant(""),
                isStreaming: false,
                isConnected: false,
                onSend: { _ in },
                onAbort: {}
            )
        }
    }
    .preferredColorScheme(.dark)
}
