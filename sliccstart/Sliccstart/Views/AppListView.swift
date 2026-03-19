import SwiftUI

struct AppListView: View {
    let targets: [AppTarget]
    @Bindable var sliccProcess: SliccProcess
    let onLaunchStandalone: (AppTarget) -> Void
    let onLaunchWithExtension: (AppTarget) -> Void
    let onLaunchElectron: (AppTarget) -> Void
    let onGuidedInstall: () -> Void
    let onUpdate: () -> Void
    let onRescan: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Text("Launch an app with SLICC attached.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.vertical, 10)
            Divider()

            List {
                // Browsers — standalone mode (throwaway profile)
                let browsers = targets.filter { $0.type == .chromiumBrowser }
                if !browsers.isEmpty {
                    Section {
                        ForEach(browsers) { target in
                            AppRow(
                                target: target,
                                isRunning: sliccProcess.target?.id == target.id && sliccProcess.isRunning,
                                onLaunch: { onLaunchStandalone(target) }
                            )
                        }
                    } header: {
                        Text("Browsers")
                    } footer: {
                        Text("Standalone mode — opens in a temporary profile.")
                            .font(.caption2)
                    }
                }

                // SLICC Extension — persistent profile + guided install
                let chromeTarget = targets.first { $0.type == .chromiumBrowser && $0.name.contains("Chrome") }
                if let chrome = chromeTarget {
                    Section {
                        // Launch with SLICC profile
                        Button { onLaunchWithExtension(chrome) } label: {
                            HStack(spacing: 12) {
                                Image(nsImage: chrome.icon)
                                    .resizable().frame(width: 32, height: 32)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Launch with Extension")
                                        .font(.body)
                                    Text("SLICC profile — extension auto-installs on first run")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if sliccProcess.target?.id == chrome.id && sliccProcess.isRunning {
                                    Circle().fill(.green).frame(width: 8, height: 8)
                                }
                            }
                        }
                        .buttonStyle(.plain)

                        // Guided install to default Chrome
                        Button { onGuidedInstall() } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "arrow.down.to.line")
                                    .font(.system(size: 16))
                                    .frame(width: 32, height: 32)
                                    .foregroundStyle(.orange)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Install to my Chrome")
                                        .font(.body)
                                    Text("Load unpacked into your default Chrome profile")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                    } header: {
                        Text("SLICC Extension")
                    }
                }

                // Electron apps
                let electronApps = targets.filter { $0.type == .electronApp }
                if !electronApps.isEmpty {
                    Section {
                        ForEach(electronApps) { target in
                            AppRow(
                                target: target,
                                isRunning: sliccProcess.target?.id == target.id && sliccProcess.isRunning,
                                onLaunch: { onLaunchElectron(target) }
                            )
                        }
                    } header: {
                        Text("Electron Apps")
                    } footer: {
                        Text("Attaches SLICC as a side panel overlay.")
                            .font(.caption2)
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
    let onLaunch: () -> Void

    var body: some View {
        Button { onLaunch() } label: {
            HStack(spacing: 12) {
                Image(nsImage: target.icon)
                    .resizable().frame(width: 32, height: 32)
                Text(target.name).font(.body)
                Spacer()
                if isRunning {
                    Circle().fill(.green).frame(width: 8, height: 8)
                }
            }
        }
        .buttonStyle(.plain)
    }
}
