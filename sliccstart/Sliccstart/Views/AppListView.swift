import SwiftUI
import AppUpdater

struct AppListView: View {
    let targets: [AppTarget]
    @Bindable var sliccProcess: SliccProcess
    @Bindable var appManagementPermission: AppManagementPermission
    @ObservedObject var appUpdater: AppUpdater
    let onLaunchStandalone: (AppTarget) -> Void
    let onLaunchElectron: (AppTarget) -> Void
    let onGuidedInstall: (AppTarget) -> Void
    let onCreateDebugBuild: (AppTarget) -> Void
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
                        isRunning: sliccProcess.isRunning(target),
                        statusDot: .running,
                        onLaunch: { onLaunchStandalone(target) },
                        onCreateDebugBuild: nil
                    )
                }
            }

            if !electronApps.isEmpty {
                SectionHeader("Desktop Apps")
                ForEach(electronApps) { target in
                    let statusDot: AppRowStatusDot = {
                        if target.debugSupport == .disabled {
                            return .needsDebugBuild
                        } else if !appManagementPermission.isGranted {
                            return .needsPermission
                        }
                        return .running
                    }()

                    AppRow(
                        target: target,
                        isRunning: sliccProcess.isRunning(target),
                        statusDot: statusDot,
                        onLaunch: {
                            if target.debugSupport == .disabled {
                                onCreateDebugBuild(target)
                            } else if appManagementPermission.isGranted {
                                onLaunchElectron(target)
                            } else {
                                appManagementPermission.openSystemSettings()
                            }
                        },
                        onCreateDebugBuild: target.debugSupport == .disabled ? { onCreateDebugBuild(target) } : nil
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
                if SliccBootstrapper.isBundled {
                    if case .downloaded(let release, _, _) = appUpdater.state {
                        Button("Restart to Update to \(release.tagName.description)") {
                            appUpdater.install()
                        }
                        .buttonStyle(.borderless).font(.caption)
                        .foregroundStyle(.green)
                    } else if case .downloading(_, _, let fraction) = appUpdater.state {
                        Text("Downloading \(Int(fraction * 100))%…")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if case .newVersionDetected(let release, _) = appUpdater.state {
                        Text("Found \(release.tagName.description)…")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button("Check for Updates") {
                            appUpdater.check()
                        }
                        .buttonStyle(.borderless).font(.caption)
                    }
                } else {
                    Button("Update") { onUpdate() }
                        .buttonStyle(.borderless).font(.caption)
                }
                if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                    Text("v\(version)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
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

enum AppRowStatusDot {
    case running
    case needsPermission
    case needsDebugBuild
}

struct AppRow: View {
    let target: AppTarget
    let isRunning: Bool
    let statusDot: AppRowStatusDot
    let onLaunch: () -> Void
    let onCreateDebugBuild: (() -> Void)?

    var body: some View {
        Button { onLaunch() } label: {
            HStack(spacing: 10) {
                ZStack(alignment: .bottomTrailing) {
                    Image(nsImage: target.icon)
                        .resizable().frame(width: 28, height: 28)
                    if target.isDebugBuild {
                        Image(systemName: "wrench.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(.white)
                            .padding(2)
                            .background(Circle().fill(.blue))
                            .offset(x: 2, y: 2)
                    }
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(target.name)
                        .font(.system(size: 13))
                    if target.isDebugBuild {
                        Text("Debug Build")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if isRunning {
                    Circle().fill(.green).frame(width: 7, height: 7)
                } else if statusDot == .needsDebugBuild {
                    Circle().fill(.red).frame(width: 7, height: 7)
                        .help("Remote debugging disabled. Click to create a debug build.")
                } else if statusDot == .needsPermission {
                    Circle().fill(.yellow).frame(width: 7, height: 7)
                        .help("App Management permission required. Click to open System Settings.")
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
