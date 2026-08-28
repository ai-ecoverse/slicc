import SliccTrayKit
import SwiftUI
import UIKit

/// The dock's `files` surface (#1866): browse the LEADER's VFS over the
/// tray (`fs.request` readDir/stat/readFile — the same requester path the
/// freezer recovery uses) and hand any file to the system share sheet,
/// which includes "Save to Files" — the Files app receives leader files
/// natively without a provider extension. A full File Provider extension
/// (mounting the VFS as a live location) is a separate target with its own
/// provisioning; the closing notes on the issue record that trade.
struct FilesView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette

    @State private var path: [String] = []
    @State private var entries: [TrayFsDirEntry]?
    @State private var error: String?
    @State private var openFile: OpenFile?

    struct OpenFile: Identifiable {
        let id = UUID()
        let name: String
        /// Raw bytes — what the share sheet exports, so binary files
        /// (images, PDFs, archives) survive untouched.
        let data: Data
        /// UTF-8 decode of `data` when it is text; nil means binary and
        /// the preview falls through to the image or size line.
        var text: String? { String(data: data, encoding: .utf8) }
        /// Decoded bitmap when the bytes are one. Checked BEFORE `text`,
        /// because a small PNG can decode as (garbage) UTF-8.
        var image: UIImage? { UIImage(data: data) }
    }

    private var currentPath: String {
        path.isEmpty ? "/" : "/" + path.joined(separator: "/")
    }

    var body: some View {
        Group {
            if let error {
                VStack(spacing: 12) {
                    Image(systemName: "folder.badge.questionmark")
                        .font(.system(size: 32))
                        .foregroundStyle(palette.inkTertiary)
                    Text(error)
                        .font(.system(size: 14))
                        .foregroundStyle(palette.inkSecondary)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("files-error")
                }
                .padding(.horizontal, 40)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let entries {
                listing(entries)
            } else {
                ProgressView("Reading \(currentPath) on the leader…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(palette.canvas)
        .task(id: currentPath) { await load() }
        .sheet(item: $openFile) { file in
            FilePreviewSheet(file: file)
                .environmentObject(appState)
        }
    }

    private func listing(_ entries: [TrayFsDirEntry]) -> some View {
        List {
            Section(currentPath) {
                if !path.isEmpty {
                    Button {
                        path.removeLast()
                    } label: {
                        Label("Up", systemImage: "arrow.turn.left.up")
                    }
                    .accessibilityIdentifier("files-up")
                }
                if entries.isEmpty {
                    Text("Empty directory")
                        .foregroundStyle(palette.inkSecondary)
                }
                ForEach(entries, id: \.name) { entry in
                    if entry.type == .directory {
                        Button {
                            path.append(entry.name)
                        } label: {
                            Label(entry.name, systemImage: "folder")
                        }
                        .accessibilityIdentifier("files-dir-\(entry.name)")
                    } else {
                        Button {
                            Task { await open(entry.name) }
                        } label: {
                            Label(entry.name, systemImage: "doc.text")
                        }
                        .accessibilityIdentifier("files-file-\(entry.name)")
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func load() async {
        error = nil
        entries = nil
        #if DEBUG
            if let fixture = UITestHooks.filesFixture(path: currentPath) {
                entries = fixture
                return
            }
        #endif
        guard appState.connectionState == .connected else {
            error = "Files live on the leader — connect to a session to browse them."
            return
        }
        do {
            entries = try await appState.fsClient.readDir(currentPath)
        } catch {
            self.error =
                "Could not read \(currentPath) from the leader: \(error.localizedDescription)"
        }
    }

    private func open(_ name: String) async {
        let filePath = currentPath == "/" ? "/\(name)" : "\(currentPath)/\(name)"
        #if DEBUG
            if UITestHooks.filesFixture(path: currentPath) != nil {
                openFile = OpenFile(
                    name: name, data: Data("fixture contents of \(filePath)\n".utf8))
                return
            }
        #endif
        do {
            // Binary-safe: bytes round-trip base64 over the tray, so a PNG
            // shared to Files is the PNG the leader holds.
            let data = try await appState.fsClient.readBinaryFile(filePath)
            openFile = OpenFile(name: name, data: data)
        } catch {
            self.error =
                "Could not read \(filePath) from the leader: \(error.localizedDescription)"
        }
    }
}

/// One fetched leader file: inline text preview plus the system share
/// sheet — "Save to Files" lands it in the Files app.
struct FilePreviewSheet: View {
    let file: FilesView.OpenFile

    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        NavigationStack {
            ScrollView {
                if let image = file.image {
                    // An image previews as an image. The web opens the same
                    // bytes in Quick Look, which renders them; a size line
                    // where a screenshot should be is the follower failing to
                    // answer the question the tap asked.
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .padding(12)
                        .accessibilityIdentifier("file-preview-image")
                } else if let text = file.text {
                    Text(text)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(palette.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .textSelection(.enabled)
                } else {
                    Label(
                        "Binary file · \(file.data.count) bytes — share to open elsewhere",
                        systemImage: "doc.zipper"
                    )
                    .font(.system(size: 13))
                    .foregroundStyle(palette.inkSecondary)
                    .padding(12)
                }
            }
            .background(palette.canvas)
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    if let url = temporaryFileURL() {
                        ShareLink(item: url) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityIdentifier("files-share")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    /// Stage the content as a real temp file so the share sheet offers
    /// file-shaped destinations (Save to Files, AirDrop) rather than
    /// treating it as a text snippet.
    private func temporaryFileURL() -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("slicc-export", isDirectory: true)
            .appendingPathComponent(file.name)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try file.data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }
}
