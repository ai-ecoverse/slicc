import SliccTrayKit
import SwiftUI
import UIKit




enum TranscriptPreviewTarget: Identifiable {
    
    
    case leaderFile(path: String, line: Int?)
    
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







struct TranscriptShareRequest: Identifiable {
    let id = UUID()
    let items: [Any]

    static func text(_ value: String) -> TranscriptShareRequest {
        TranscriptShareRequest(items: [value])
    }

    
    
    static func blob(name: String, data: Data) -> TranscriptShareRequest? {
        guard let url = TranscriptTempFile.write(name: name, data: data) else { return nil }
        return TranscriptShareRequest(items: [url])
    }
}



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








@MainActor
final class TranscriptActionModel: ObservableObject {
    @Published var preview: TranscriptPreviewTarget?
    @Published var share: TranscriptShareRequest?
}









struct TranscriptActionHandlers {
    var preview: (TranscriptPreviewTarget) -> Void = { _ in }
    var share: (TranscriptShareRequest?) -> Void = { _ in }
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




private struct FileMentionResolverKey: EnvironmentKey {
    static let defaultValue: FileMentionResolver? = nil
}

extension EnvironmentValues {
    var fileMentionResolver: FileMentionResolver? {
        get { self[FileMentionResolverKey.self] }
        set { self[FileMentionResolverKey.self] = newValue }
    }
}




enum TranscriptClipboard {
    static func copy(_ text: String) {
        UIPasteboard.general.string = text
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}






struct TranscriptShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}



extension View {
    
    
    func transcriptActionSheets(_ model: TranscriptActionModel) -> some View {
        sheet(item: Binding(get: { model.preview }, set: { model.preview = $0 })) { target in
            TranscriptPreviewSheet(target: target)
        }
        .sheet(item: Binding(get: { model.share }, set: { model.share = $0 })) { request in
            TranscriptShareSheet(items: request.items)
                .presentationDetents([.medium, .large])
        }
    }
}







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
