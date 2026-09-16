import OSLog
import PhotosUI
import SliccTrayKit
import SwiftUI
import UIKit

private let logger = Logger(subsystem: "com.sliccy.follower", category: "composer")

struct InputBar: View {
    @Binding var text: String
    let isStreaming: Bool

    let isConnected: Bool

    var isStalled: Bool = false

    var steersActiveScoop: Bool = true

    @ObservedObject var ptt: PttController

    let onSend: (String, [MessageAttachment]?, Bool) -> Void
    let onAbort: () -> Void

    var onSteer: (String, [MessageAttachment]?) -> Void = { _, _ in }

    @FocusState private var isFocused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.palette) private var palette

    @Binding var stagedAttachments: [MessageAttachment]
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCamera = false

    @State private var pasteboardHasImage = false

    private var canSend: Bool {

        isComposable
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !stagedAttachments.isEmpty)
    }

    private var isComposable: Bool { isConnected && !isStalled }

    private var placeholderText: String {
        if isStalled { return "The leader is busy — hang on…" }
        return isConnected ? "Message..." : "Disconnected"
    }

    var body: some View {
        VStack(spacing: 0) {

            Rectangle()
                .fill(palette.line)
                .frame(height: 0.5)

            if !stagedAttachments.isEmpty {
                StagedAttachmentsRow(attachments: stagedAttachments) { removed in
                    stagedAttachments.removeAll { $0.id == removed.id }
                }
            }

            HStack(alignment: .bottom, spacing: 10) {

                attachButton

                textField

                actionButton
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(palette.surface)

        .animation(.easeInOut(duration: 0.2), value: isStreaming)
        .overlay {

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

            DispatchQueue.main.async {
                pasteboardHasImage = UIPasteboard.general.hasImages
            }
        }

        .onChange(of: ptt.event) { _, event in
            guard let event else { return }
            switch event.kind {
            case .commit(let transcript):

                if !submit(transcript, dictated: true) {
                    logger.notice("dictation not sent — composer unavailable; kept as draft")
                    text = transcript
                }
            case .quickTap:

                isFocused = true
            }
        }
        .onChange(of: scenePhase) { _, phase in

            if phase != .active {
                ptt.pressCancelled()
            }
        }
        .onChange(of: pttArmed) { _, armed in

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

    @ViewBuilder
    private var textField: some View {
        ZStack(alignment: .topLeading) {

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

                .onKeyPress(keys: [.return]) { event in
                    let reserved: EventModifiers = [.shift, .command, .control, .option]
                    guard event.modifiers.intersection(reserved).isEmpty else { return .ignored }
                    sendIfPossible()
                    return .handled
                }

                .allowsHitTesting(!pttArmed)
        }
        .background(palette.field)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(palette.ink.opacity(0.12), lineWidth: 0.5)
        )
        .overlay {

            if pttArmed {
                PttPressSurface(
                    onDown: { ptt.pressDown() },
                    onUp: { ptt.pressUp() }
                )
            }
        }
    }

    private var pttArmed: Bool { text.isEmpty }

    static func makeDictationEngine() -> DictationEngine {
        #if DEBUG
            if let scripted = UITestHooks.speechEngine() { return scripted }
        #endif
        return AppleDictationEngine()
    }

    @ViewBuilder
    private var actionButton: some View {
        if isStreaming {
            HStack(spacing: 6) {
                if canSend && steersActiveScoop {

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

    private func sendIfPossible() {
        _ = submit(text, dictated: false)
    }

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

        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onSteer(trimmed, stagedAttachments.isEmpty ? nil : stagedAttachments)
        text = ""
        stagedAttachments = []
    }
}

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
