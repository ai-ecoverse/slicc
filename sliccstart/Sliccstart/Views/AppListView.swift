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
        VStack(alignment: .leading, spacing: 0) {
            let browsers = targets.filter { $0.type == .chromiumBrowser }
            let electronApps = targets.filter { $0.type == .electronApp }
            let chromeTarget = targets.first { $0.type == .chromiumBrowser && $0.name.contains("Chrome") }

            if !browsers.isEmpty {
                SectionHeader("Browsers")
                ForEach(browsers) { target in
                    AppRow(
                        target: target,
                        isRunning: sliccProcess.target?.id == target.id && sliccProcess.isRunning,
                        onLaunch: { onLaunchStandalone(target) }
                    )
                }
            }

            if !electronApps.isEmpty {
                SectionHeader("Electron Apps")
                ForEach(electronApps) { target in
                    AppRow(
                        target: target,
                        isRunning: sliccProcess.target?.id == target.id && sliccProcess.isRunning,
                        onLaunch: { onLaunchElectron(target) }
                    )
                }
            }

            if let chrome = chromeTarget {
                SectionHeader("Extension")
                Button { onGuidedInstall(chrome) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "puzzlepiece.extension")
                            .font(.system(size: 15))
                            .frame(width: 28, height: 28)
                            .foregroundStyle(.orange)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Install to Chrome")
                                .font(.system(size: 13))
                            Text("Guided setup — requires Developer Mode")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            Spacer(minLength: 0)

            Divider()
            HStack {
                Button("Update") { onUpdate() }
                    .buttonStyle(.borderless).font(.caption)
                Spacer()
                Button("Rescan") { onRescan() }
                    .buttonStyle(.borderless).font(.caption)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
    }
}

struct SectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 4)
    }
}

struct AppRow: View {
    let target: AppTarget
    let isRunning: Bool
    let onLaunch: () -> Void

    var body: some View {
        Button { onLaunch() } label: {
            HStack(spacing: 10) {
                Image(nsImage: target.icon)
                    .resizable().frame(width: 28, height: 28)
                Text(target.name)
                    .font(.system(size: 13))
                Spacer()
                if isRunning {
                    Circle().fill(.green).frame(width: 7, height: 7)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }
}
