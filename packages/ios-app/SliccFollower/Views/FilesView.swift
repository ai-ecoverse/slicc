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
        let content: String
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
                    name: name, content: "fixture contents of \(filePath)\n")
                return
            }
        #endif
        do {
            let content = try await appState.fsClient.readFile(filePath)
            openFile = OpenFile(name: name, content: content)
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
                Text(file.content)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(palette.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .textSelection(.enabled)
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
            try file.content.write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            return nil
        }
    }
}
