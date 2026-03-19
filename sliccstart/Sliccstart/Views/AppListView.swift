import SwiftUI

struct AppListView: View {
    let targets: [AppTarget]
    @Bindable var sliccProcess: SliccProcess
    let onLaunchBrowser: (AppTarget) -> Void
    let onLaunchElectron: (AppTarget) -> Void
    let onInstallExtension: (AppTarget) -> Void
    let onUpdate: () -> Void
    let onRescan: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Text("Sliccstart")
                .font(.headline)
                .padding(.vertical, 12)
            Text("Launch an app from the list below.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.bottom, 8)
            Divider()

            List {
                let browsers = targets.filter { $0.type == .chromiumBrowser }
                if !browsers.isEmpty {
                    Section("Browsers") {
                        ForEach(browsers) { target in
                            AppRow(
                                target: target,
                                isRunning: sliccProcess.target?.id == target.id && sliccProcess.isRunning,
                                showInstallButton: target.name.contains("Chrome"),
                                onLaunch: { onLaunchBrowser(target) },
                                onInstallExtension: { onInstallExtension(target) }
                            )
                        }
                    }
                }
                let electronApps = targets.filter { $0.type == .electronApp }
                if !electronApps.isEmpty {
                    Section("Electron Apps") {
                        ForEach(electronApps) { target in
                            AppRow(
                                target: target,
                                isRunning: sliccProcess.target?.id == target.id && sliccProcess.isRunning,
                                showInstallButton: false,
                                onLaunch: { onLaunchElectron(target) },
                                onInstallExtension: {}
                            )
                        }
                    }
                }
            }
            .listStyle(.inset)

            Divider()
            HStack {
                Button("Update SLICC") { onUpdate() }
                    .buttonStyle(.borderless).font(.caption)
                Spacer()
                Button("Rescan") { onRescan() }
                    .buttonStyle(.borderless).font(.caption)
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
    }
}

struct AppRow: View {
    let target: AppTarget
    let isRunning: Bool
    let showInstallButton: Bool
    let onLaunch: () -> Void
    let onInstallExtension: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(nsImage: target.icon)
                .resizable().frame(width: 32, height: 32)
            Text(target.name).font(.body)
            Spacer()
            if isRunning {
                Circle().fill(.green).frame(width: 8, height: 8)
            }
            if showInstallButton {
                Button { onInstallExtension() } label: {
                    Image(systemName: "puzzlepiece.extension").font(.system(size: 14))
                }
                .buttonStyle(.borderless)
                .help("Install SLICC extension permanently")
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { onLaunch() }
    }
}
