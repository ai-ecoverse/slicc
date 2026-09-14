import SliccTrayKit
import SwiftUI
import UIKit








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
        
        
        let data: Data
        
        
        
        
        
        var text: String? { String(data: data, encoding: .utf8) }
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
            
            
            let data = try await appState.fsClient.readBinaryFile(filePath)
            openFile = OpenFile(name: name, data: data)
        } catch {
            self.error =
                "Could not read \(filePath) from the leader: \(error.localizedDescription)"
        }
    }
}




struct FilePreviewSheet: View {
    let file: FilesView.OpenFile

    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    
    
    
    @State private var stagedURL: URL?

    var body: some View {
        NavigationStack {
            content
                .background(palette.canvas)
                .navigationTitle(file.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        if let stagedURL {
                            ShareLink(item: stagedURL) {
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
        .task(id: file.id) { stagedURL = temporaryFileURL() }
    }

    @ViewBuilder
    private var content: some View {
        if let text = readableText {
            
            
            
            
            
            ScrollView {
                Text(text)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(palette.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("file-preview-text")
            }
        } else if let stagedURL, QuickLookPreview.canPreview(stagedURL) {
            
            
            
            QuickLookPreview(url: stagedURL)
                .accessibilityIdentifier("file-preview-quicklook")
        } else {
            ScrollView {
                Label(
                    "Binary file · \(file.data.count) bytes — share to open elsewhere",
                    systemImage: "doc.zipper"
                )
                .font(.system(size: 13))
                .foregroundStyle(palette.inkSecondary)
                .padding(12)
            }
        }
    }

    
    
    
    
    
    
    
    private var readableText: String? {
        guard MagicBytes.looksLikeText(file.data) else { return nil }
        return file.text
    }

    
    
    
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
