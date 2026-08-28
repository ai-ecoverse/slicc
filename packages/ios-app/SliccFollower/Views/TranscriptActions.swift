import SliccTrayKit
import SwiftUI
import UIKit

// MARK: - Requests

/// What a transcript tap or long press asked the shell to open.
enum TranscriptPreviewTarget: Identifiable {
    /// A file the resolver confirmed on the leader. Bytes are fetched when the
    /// sheet appears, not when the link is painted.
    case leaderFile(path: String, line: Int?)
    /// A base64 blob already decoded in the transcript.
    case payload(Base64Payload)

    var id: String {
        switch self {
        case .leaderFile(let path, let line): return "file:\(path)#\(line ?? 0)"
        case .payload(let payload): return "payload:\(payload.id)"
        }
    }

    var title: String {
        switch self {
        case .leaderFile(let path, _): return (path as NSString).lastPathComponent
        case .payload(let payload): return payload.name
        }
    }
}

/// A staged share-sheet invocation.
///
/// Text and file URLs are separated because `UIActivityViewController` treats
/// them differently: a `String` offers Messages/Mail/Copy, a file URL offers
/// Save to Files and AirDrop. Handing it a string when the user wanted a file
/// silently drops the useful half of the sheet.
struct TranscriptShareRequest: Identifiable {
    let id = UUID()
    let items: [Any]

    static func text(_ value: String) -> TranscriptShareRequest {
        TranscriptShareRequest(items: [value])
    }

    /// Stage bytes as a real temp file so the sheet offers file-shaped
    /// destinations. Mirrors `FilePreviewSheet.temporaryFileURL`.
    static func blob(name: String, data: Data) -> TranscriptShareRequest? {
        guard let url = TranscriptTempFile.write(name: name, data: data) else { return nil }
        return TranscriptShareRequest(items: [url])
    }
}

/// Where a shared blob is staged. One directory, reused, so a long session
/// does not scatter exports across the temp root.
enum TranscriptTempFile {
    static func write(name: String, data: Data) -> URL? {
        let safe = name.isEmpty ? "payload" : (name as NSString).lastPathComponent
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("slicc-transcript", isDirectory: true)
            .appendingPathComponent(safe)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }
}

// MARK: - Model

/// Presentation state for the transcript's short actions.
///
/// Owned by `ChatView`, which mounts the sheets once for the whole shell —
/// a sheet per bubble would be torn down mid-present every time the transcript
/// re-renders, and the transcript re-renders constantly.
@MainActor
final class TranscriptActionModel: ObservableObject {
    @Published var preview: TranscriptPreviewTarget?
    @Published var share: TranscriptShareRequest?
    /// The inline-code run whose short-action menu is open. A tap on
    /// pre-formatted text has no default worth guessing between Copy and
    /// Share, so it asks.
    @Published var codeMenu: TranscriptCodeMenu?
}

/// The pre-formatted run behind an open short-action menu.
struct TranscriptCodeMenu: Identifiable {
    let id = UUID()
    let text: String
}

// MARK: - Environment

/// Closures the transcript reaches the shell through.
///
/// A struct of closures rather than an `EnvironmentObject`, for the same
/// reason `inlineSprinkleLick` is: `MessageBubble` is `Equatable` so SwiftUI
/// can skip unchanged rows, and an observed object that publishes when a sheet
/// opens would invalidate every row on screen.
struct TranscriptActionHandlers {
    var preview: (TranscriptPreviewTarget) -> Void = { _ in }
    var share: (TranscriptShareRequest?) -> Void = { _ in }
    /// Open Copy/Share for a run of pre-formatted text.
    var codeMenu: (String) -> Void = { _ in }
}

private struct TranscriptActionHandlersKey: EnvironmentKey {
    static let defaultValue = TranscriptActionHandlers()
}

extension EnvironmentValues {
    var transcriptActions: TranscriptActionHandlers {
        get { self[TranscriptActionHandlersKey.self] }
        set { self[TranscriptActionHandlersKey.self] = newValue }
    }
}

/// The resolver the transcript checks file mentions against. Absent by default
/// so previews, fixtures and unit hosts render inert mentions rather than
/// reaching for a leader that is not there.
private struct FileMentionResolverKey: EnvironmentKey {
    static let defaultValue: FileMentionResolver? = nil
}

extension EnvironmentValues {
    var fileMentionResolver: FileMentionResolver? {
        get { self[FileMentionResolverKey.self] }
        set { self[FileMentionResolverKey.self] = newValue }
    }
}

// MARK: - Clipboard

/// Copy, in one place, so every short action reports the same way.
enum TranscriptClipboard {
    static func copy(_ text: String) {
        UIPasteboard.general.string = text
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

// MARK: - Share sheet

/// `UIActivityViewController` in a sheet. SwiftUI's `ShareLink` needs a
/// `Transferable` known at view-build time; the transcript's items are decided
/// by a tap, so the UIKit controller is the honest fit.
struct TranscriptShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Shell wiring

extension View {
    /// Mount the transcript's short-action surfaces. Applied once, at the
    /// shell, above both the compact and the regular layout.
    func transcriptActionSheets(_ model: TranscriptActionModel) -> some View {
        sheet(item: Binding(get: { model.preview }, set: { model.preview = $0 })) { target in
            TranscriptPreviewSheet(target: target)
        }
        .sheet(item: Binding(get: { model.share }, set: { model.share = $0 })) { request in
            TranscriptShareSheet(items: request.items)
                .presentationDetents([.medium, .large])
        }
        .confirmationDialog(
            "Code",
            isPresented: Binding(
                get: { model.codeMenu != nil },
                set: { if !$0 { model.codeMenu = nil } }),
            titleVisibility: .hidden,
            presenting: model.codeMenu
        ) { menu in
            Button("Copy") { TranscriptClipboard.copy(menu.text) }
                .accessibilityIdentifier("transcript-code-copy")
            Button("Share…") { model.share = .text(menu.text) }
                .accessibilityIdentifier("transcript-code-share")
            Button("Cancel", role: .cancel) {}
        } message: { menu in
            // The run itself is the title: on a phone the tap target was four
            // characters wide, and confirming WHICH snippet is about to leave
            // the app is the whole reason this is a menu and not a silent copy.
            Text(menu.text)
        }
    }
}

// MARK: - Preview sheet

/// One previewed thing — a leader file fetched on appear, or a base64 payload
/// already decoded. Both end in the same body as the Files surface's preview
/// (`FilePreviewSheet`), so a file opened from prose and a file opened from
/// the file browser look identical.
struct TranscriptPreviewSheet: View {
    let target: TranscriptPreviewTarget

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var loaded: FilesView.OpenFile?
    @State private var error: String?

    var body: some View {
        Group {
            if let loaded {
                FilePreviewSheet(file: loaded)
            } else if let error {
                failure(error)
            } else {
                loading
            }
        }
        .task(id: target.id) { await load() }
    }

    private var loading: some View {
        NavigationStack {
            ProgressView("Reading \(target.title) on the leader…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.canvas)
                .navigationTitle(target.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }

    private func failure(_ message: String) -> some View {
        NavigationStack {
            VStack(spacing: 12) {
                Image(systemName: "doc.badge.ellipsis")
                    .font(.system(size: 32))
                    .foregroundStyle(palette.inkTertiary)
                Text(message)
                    .font(.system(size: 14))
                    .foregroundStyle(palette.inkSecondary)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("transcript-preview-error")
            }
            .padding(.horizontal, 40)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(palette.canvas)
            .navigationTitle(target.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func load() async {
        switch target {
        case .payload(let payload):
            // Already in memory — the chip only exists because the bytes
            // decoded and were recognised.
            loaded = FilesView.OpenFile(name: payload.name, data: payload.bytes)
        case .leaderFile(let path, _):
            guard appState.connectionState == .connected else {
                error = "This file lives on the leader — connect to a session to open it."
                return
            }
            do {
                let data = try await appState.fsClient.readBinaryFile(path)
                loaded = FilesView.OpenFile(name: (path as NSString).lastPathComponent, data: data)
            } catch {
                self.error = "Could not read \(path) from the leader: \(error.localizedDescription)"
            }
        }
    }
}
