import SwiftUI

struct AppListView: View {
    let targets: [AppTarget]
    @Bindable var sliccProcess: SliccProcess
    let onLaunchStandalone: (AppTarget) -> Void
    let onLaunchElectron: (AppTarget) -> Void
    let onGuidedInstall: (AppTarget) -> Void
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
                // Browsers — standalone mode
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

                // Guided install
                let chromeTarget = targets.first { $0.type == .chromiumBrowser && $0.name.contains("Chrome") }
                if let chrome = chromeTarget {
                    Section {
                        Button { onGuidedInstall(chrome) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "arrow.down.to.line")
                                    .font(.system(size: 16))
                                    .frame(width: 32, height: 32)
                                    .foregroundStyle(.orange)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Install Extension to Chrome")
                                        .font(.body)
                                    Text("Guided setup — opens chrome://extensions")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                    } header: {
                        Text("Extension")
                    } footer: {
                        Text("Permanently installs the SLICC side panel into your Chrome profile. Requires Developer Mode.")
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
