import OSLog
import PhotosUI
import SliccTrayKit
import SwiftUI
import UIKit

private let logger = Logger(subsystem: "com.sliccy.follower", category: "composer")

struct InputBar: View {
    @Binding var text: String
    let isStreaming: Bool
    /// Both of these arrive SETTLED (`AppState.settledConnection`), never raw:
    /// a blip that heals inside the hold must not reach the composer at all.
    let isConnected: Bool
    /// Leader stopped answering pings while its channel stayed open. Sending is
    /// blocked, but this is not a disconnect and must not read as one.
    var isStalled: Bool = false
    /// A scoop-less `user_message` routes to the leader's ACTIVE scoop;
    /// when the follower is viewing a different one, the streaming-send /
    /// steer affordance hides so an interrupt cannot hit the wrong turn.
    var steersActiveScoop: Bool = true
    /// Push-to-talk controller owned above the adaptive shell branch so an
    /// in-flight hold survives a live resize.
    @ObservedObject var ptt: PttController
    /// Send the composed message: trimmed text + any staged attachments
    /// (nil rather than an empty array, matching the wire shape) + whether
    /// the turn was dictated, which arms the spoken reply.
    let onSend: (String, [MessageAttachment]?, Bool) -> Void
    let onAbort: () -> Void
    /// Send interrupting the running turn (`user_message.steer`). Only
    /// reachable while streaming, via the long-press menu on send.
    var onSteer: (String, [MessageAttachment]?) -> Void = { _, _ in }

    @FocusState private var isFocused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.palette) private var palette

    /// Photos staged for the next send (downscaled + base64 already). Owned by
    /// the shell rather than here, so an adaptive layout change — which
    /// rebuilds this composer — cannot silently discard what the user picked,
    /// and a `PhotosPicker` load in flight cannot land in a discarded copy.
    @Binding var stagedAttachments: [MessageAttachment]
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    /// `UIPasteboard.general.hasImages` is not SwiftUI-observable — track
    /// pasteboard changes and foreground returns (an image copied in
    /// another app must surface Paste on the next menu open). Read lazily
    /// in onAppear, NOT at struct init: the initial read is a synchronous
    /// XPC to the pasteboard daemon, and on a contended simulator it can
    /// stall the main thread through app launch. `hasImages` is a metadata
    /// check, so none of this trips the paste banner.
    @State private var pasteboardHasImage = false

    private var canSend: Bool {
        // Sending during a running turn queues on the leader (browser
        // parity); only an empty composer or an unusable connection blocks.
        // A staged photo with no caption is a legal send (web parity).
        isComposable
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !stagedAttachments.isEmpty)
    }

    /// Whether a message can be handed to the leader at all. Gates SENDING
    /// only — typing stays available in every connection state, so a draft
    /// survives a drop instead of being refused while it lasts.
    private var isComposable: Bool { isConnected && !isStalled }

    /// Shown while the composer is empty, so the reason sending is unavailable
    /// is on screen before anything is typed.
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

            if !stagedAttachments.isEmpty {
                StagedAttachmentsRow(attachments: stagedAttachments) { removed in
                    stagedAttachments.removeAll { $0.id == removed.id }
                }
            }

            HStack(alignment: .bottom, spacing: 10) {
                // Attachment menu (library / camera / paste)
                attachButton
                // Text input area
                textField
                // Action button (send or abort)
                actionButton
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(palette.surface)
        // Deliberately NOT `.disabled(!isComposable)`. Disabling this band
        // disables the `TextEditor` inside it, and a disabled editor resigns
        // first responder — so a connection blip pulled the keyboard out from
        // under someone mid-sentence, and re-enabling put it back, unasked.
        // The keyboard belongs to composer focus and nothing else. What an
        // unusable leader blocks is SENDING (`canSend` / `submit`), which the
        // placeholder explains and the send button shows.
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
                if UITestHooks.stagesAttachmentFixture, stagedAttachments.isEmpty {
                    stage(UITestHooks.attachmentFixtureImage(), name: "fixture.jpg")
                }
            #endif
            // Deferred first pasteboard read (see pasteboardHasImage) — off
            // the launch-critical path, still ahead of any menu open.
            DispatchQueue.main.async {
                pasteboardHasImage = UIPasteboard.general.hasImages
            }
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
                // transcript IS the message — submit it directly instead of
                // writing `text` and re-reading it through the binding, which
                // made the send depend on when SwiftUI published the write.
                // If the leader turned unsendable mid-hold, fall back to
                // leaving the words in the composer: dictation that cannot
                // be delivered must not evaporate.
                if !submit(transcript, dictated: true) {
                    logger.notice("dictation not sent — composer unavailable; kept as draft")
                    text = transcript
                }
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
            // The surface unmounts the moment text arrives (a dictation
            // committing into the composer, a paste) — its onEnded then never
            // fires, so cancel here or the mic stays live behind a surface
            // that is gone.
            if !armed {
                ptt.pressCancelled()
            }
        }
        .onReceive(
            NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)
        ) { _ in
            pasteboardHasImage = UIPasteboard.general.hasImages
        }
        .onReceive(
            NotificationCenter.default.publisher(
                for: UIApplication.willEnterForegroundNotification)
        ) { _ in
            // Cross-app copies do not fire the pasteboard notification in
            // THIS process — re-check on every return to the foreground.
            pasteboardHasImage = UIPasteboard.general.hasImages
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $photoItems,
            maxSelectionCount: 4,
            matching: .images
        )
        .onChange(of: photoItems) { _, items in
            loadPhotoItems(items)
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(
                onCapture: { image in
                    stage(image, name: "camera.jpg")
                    showCamera = false
                },
                onCancel: { showCamera = false }
            )
            .ignoresSafeArea()
        }
    }

    // MARK: - Attachments

    /// The composer's capture menu. Camera appears only where one exists
    /// (never in a simulator), paste only while the pasteboard holds an
    /// image — an option that would fail must disappear instead.
    @ViewBuilder
    private var attachButton: some View {
        Menu {
            Button {
                showPhotoPicker = true
            } label: {
                Label("Photo Library", systemImage: "photo.on.rectangle")
            }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button {
                    showCamera = true
                } label: {
                    Label("Camera", systemImage: "camera")
                }
            }
            if pasteboardHasImage {
                Button {
                    pasteImages()
                } label: {
                    Label("Paste Image", systemImage: "doc.on.clipboard")
                }
            }
        } label: {
            Image(systemName: "plus.circle.fill")
                .font(.system(size: 26))
                .foregroundStyle(palette.inkSecondary)
        }
        .accessibilityIdentifier("attach-menu")
        .padding(.bottom, 4)
    }

    private func stage(_ image: UIImage, name: String) {
        // The shared budget keeps a multi-photo message under the tray
        // ceiling at STAGING time — over-budget photos become error chips
        // here instead of a send the transport must refuse later.
        let used = stagedAttachments.reduce(0) { $0 + ($1.data?.count ?? 0) }
        stagedAttachments.append(
            ImageAttachmentBuilder.inlineAttachment(
                from: image, name: name,
                base64BudgetRemaining: ImageAttachmentBuilder.messageBase64Budget - used))
    }

    private func pasteImages() {
        for (index, image) in (UIPasteboard.general.images ?? []).enumerated() {
            stage(image, name: "pasted-\(index + 1).jpg")
        }
    }

    /// Drain picked library items into staged attachments.
    private func loadPhotoItems(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photoItems = []
        Task { @MainActor in
            for (index, item) in items.enumerated() {
                guard let data = try? await item.loadTransferable(type: Data.self),
                    let image = UIImage(data: data)
                else { continue }
                stage(image, name: "photo-\(index + 1).jpg")
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
                // TextEditor owns Return as a newline, so onSubmit does not
                // fire for a hardware keyboard. Consume ordinary Return here;
                // editing/command modifiers continue to the editor instead of
                // surprise-sending (Shift-Return remains a line break).
                .onKeyPress(keys: [.return]) { event in
                    let reserved: EventModifiers = [.shift, .command, .control, .option]
                    guard event.modifiers.intersection(reserved).isEmpty else { return .ignored }
                    sendIfPossible()
                    return .handled
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

    /// The press surface mounts (and the editor yields its touches) on an
    /// empty composer — whatever the connection is doing.
    ///
    /// Deliberately NOT `&& isComposable`. This flag drives
    /// `allowsHitTesting` on the editor and mounts an overlay above it, so
    /// tying it to the connection put a live transport event straight into the
    /// first-responder layer: with an empty, focused composer — exactly the
    /// state someone is in when they tap to start writing — a drop or a stall
    /// toggled hit-testing under the keyboard and mounted an overlay on top of
    /// it, and the keyboard flapped. That is the same coupling the composer's
    /// `.disabled` used to have, in the one place it survived being removed.
    ///
    /// Dictating with no usable leader is allowed and lands somewhere useful:
    /// `submit` refuses it and the transcript is kept in the composer as a
    /// draft (see the `.commit` handler), which beats taking the microphone
    /// away because a ping was late.
    private var pttArmed: Bool { text.isEmpty }

    /// The recognizer behind push-to-talk: a UI test's scripted fake when
    /// the launch arguments ask for one, Apple's on-device engine otherwise.
    static func makeDictationEngine() -> DictationEngine {
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
            Button {
                sendIfPossible()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(canSend ? palette.accent : palette.inkTertiary.opacity(0.6))
            }
            .disabled(!canSend)
            .accessibilityIdentifier("composer-send")
            .transition(.scale.combined(with: .opacity))
            .padding(.bottom, 2)
        }
    }

    // MARK: - Actions

    private func sendIfPossible() {
        _ = submit(text, dictated: false)
    }

    /// The one send path. Takes the body explicitly so push-to-talk can
    /// submit a transcript the composer binding has not published yet, and
    /// reports whether the message actually went out so a caller holding the
    /// only copy of it can decide what to do when it did not.
    @discardableResult
    private func submit(_ body: String, dictated: Bool) -> Bool {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isComposable, !trimmed.isEmpty || !stagedAttachments.isEmpty else { return false }
        onSend(trimmed, stagedAttachments.isEmpty ? nil : stagedAttachments, dictated)
        text = ""
        stagedAttachments = []
        return true
    }

    private func steerIfPossible() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, isStreaming else { return }
        // Interrupting work in progress deserves a physical acknowledgment.
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onSteer(trimmed, stagedAttachments.isEmpty ? nil : stagedAttachments)
        text = ""
        stagedAttachments = []
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
                ptt: PttController(engine: InputBar.makeDictationEngine()),
                onSend: { _, _, _ in },
                onAbort: {},
                stagedAttachments: .constant([])
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
                ptt: PttController(engine: InputBar.makeDictationEngine()),
                onSend: { _, _, _ in },
                onAbort: {},
                stagedAttachments: .constant([])
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
                ptt: PttController(engine: InputBar.makeDictationEngine()),
                onSend: { _, _, _ in },
                onAbort: {},
                stagedAttachments: .constant([])
            )
        }
    }
    .preferredColorScheme(.dark)
}
