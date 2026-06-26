import SwiftUI
import AppUpdater

struct AppListView: View {
    let targets: [AppTarget]
    @Bindable var sliccProcess: SliccProcess
    @Bindable var appManagementPermission: AppManagementPermission
    @ObservedObject var appUpdater: AppUpdater
    let onLaunchStandalone: (AppTarget) -> Void
    let onLaunchElectron: (AppTarget) -> Void
    let onCreateDebugBuild: (AppTarget) -> Void
    let onUpdate: () -> Void
    let onBeginUpdate: () -> Void
    let onRescan: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            let browsers = targets.filter { $0.type == .chromiumBrowser }
            let electronApps = targets.filter { $0.type == .electronApp }

            if !browsers.isEmpty {
                SectionHeader("Browsers")
                ForEach(browsers) { target in
                    AppRow(
                        target: target,
                        runtimeState: sliccProcess.runtimeState(for: target),
                        onLaunch: { onLaunchStandalone(target) },
                        onCreateDebugBuild: nil
                    )
                }
            }

            if !electronApps.isEmpty {
                SectionHeader("Desktop Apps")
                ForEach(electronApps) { target in
                    let runtimeState = sliccProcess.runtimeState(
                        for: target,
                        hasAppManagementPermission: appManagementPermission.isGranted
                    )

                    AppRow(
                        target: target,
                        runtimeState: runtimeState,
                        onLaunch: {
                            if runtimeState == .cannotStart(.needsDebugBuild) {
                                onCreateDebugBuild(target)
                            } else if runtimeState == .cannotStart(.needsPermission) {
                                appManagementPermission.openSystemSettings()
                            } else if runtimeState == .cannotStart(.needsLeader) {
                                // Row is disabled in this state, but defend
                                // against future call sites: do nothing.
                                return
                            } else {
                                onLaunchElectron(target)
                            }
                        },
                        onCreateDebugBuild: target.debugSupport == .disabled ? { onCreateDebugBuild(target) } : nil
                    )
                }
            }

            SectionHeader("Extension")
            Button { sliccProcess.openChromeWebStore() } label: {
                HStack(spacing: 10) {
                    Image(systemName: "puzzlepiece.extension")
                        .font(.system(size: 15))
                        .frame(width: 28, height: 28)
                        .foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Get Extension")
                            .font(.system(size: 13))
                        Text("Install from Chrome Web Store")
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
            .accessibilityIdentifier("get-extension")
            .accessibilityLabel("Get Extension")

            Spacer(minLength: 0)

            Divider()
            HStack {
                updateButton
                if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                    Text("v\(version)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Button("Rescan") { onRescan() }
                    .buttonStyle(.borderless).font(.caption)
                    .accessibilityIdentifier("rescan")
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private var updateButton: some View {
        if SliccBootstrapper.isBundled {
            fullUpdateButton
        } else {
            Button("Update") { onUpdate() }
                .buttonStyle(.borderless).font(.caption)
                .accessibilityIdentifier("update")
        }
    }

    @ViewBuilder
    private var fullUpdateButton: some View {
        if let bundle = appUpdater.downloadedAppBundle {
            if let version = bundle.infoDictionary?["CFBundleShortVersionString"] as? String, !version.isEmpty {
                Button("Restart to Update to v\(version)") {
                    onBeginUpdate()
                    appUpdater.install(bundle)
                }
                .buttonStyle(.borderless).font(.caption)
                .foregroundStyle(.green)
                .accessibilityIdentifier("restart-to-update")
            } else {
                Button("Restart to Update") {
                    onBeginUpdate()
                    appUpdater.install(bundle)
                }
                .buttonStyle(.borderless).font(.caption)
                .foregroundStyle(.green)
                .accessibilityIdentifier("restart-to-update")
            }
        } else {
            Button("Check for Updates") {
                appUpdater.check()
            }
            .buttonStyle(.borderless).font(.caption)
            .accessibilityIdentifier("check-for-updates")
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
    case runningWithDebug
    case runningWithoutDebug
    case needsPermission
    case needsDebugBuild
    case needsLeader
    case failed
}

struct AppRow: View {
    let target: AppTarget
    let runtimeState: AppRuntimeState
    let onLaunch: () -> Void
    let onCreateDebugBuild: (() -> Void)?

    private var isDisabled: Bool {
        runtimeState == .cannotStart(.needsLeader)
    }

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
                    if let subtitle {
                        Text(subtitle)
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if let dot = statusDot {
                    Circle().fill(dot.color).frame(width: 7, height: 7)
                        .help(dot.help)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .help(isDisabled ? AppRowStatusDot.needsLeader.help : "")
        .accessibilityIdentifier("app-row-\(target.name)")
        .accessibilityLabel(target.name)
        .onHover { hovering in
            // Avoid the pointing-hand affordance when the row is disabled
            // — the user can't actually start the app without a leader.
            guard !isDisabled else { return }
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    private var statusDot: AppRowStatusDot? {
        switch runtimeState {
        case .notRunning:
            return nil
        case .runningWithoutDebug:
            return .runningWithoutDebug
        case .runningWithDebug:
            return .runningWithDebug
        case .startFailed:
            return .failed
        case .cannotStart(.needsDebugBuild):
            return .needsDebugBuild
        case .cannotStart(.needsPermission):
            return .needsPermission
        case .cannotStart(.needsLeader):
            return .needsLeader
        }
    }

    private var subtitle: String? {
        switch runtimeState {
        case .notRunning:
            return target.isDebugBuild ? "Debug Build" : nil
        case .runningWithoutDebug:
            return "Running without SLICC"
        case .runningWithDebug(let cdpPort):
            if let cdpPort {
                return "Running with SLICC on \(cdpPort)"
            }
            return "Running with SLICC"
        case .startFailed:
            return "Start failed"
        case .cannotStart(.needsDebugBuild):
            return "Needs Debug Build"
        case .cannotStart(.needsPermission):
            return "Needs Permission"
        case .cannotStart(.needsLeader):
            return "Start a browser first"
        }
    }
}

extension AppRowStatusDot {
    var color: Color {
        switch self {
        case .runningWithDebug:
            return .green
        case .runningWithoutDebug, .needsPermission:
            return .yellow
        case .needsDebugBuild, .failed:
            return .red
        case .needsLeader:
            return .gray
        }
    }

    var help: String {
        switch self {
        case .runningWithDebug:
            return "Running with SLICC."
        case .runningWithoutDebug:
            return "Running without a known SLICC debug port. Click to restart."
        case .needsDebugBuild:
            return "Remote debugging disabled. Click to create a debug build."
        case .needsPermission:
            return "App Management permission required. Click to open System Settings."
        case .needsLeader:
            return "Start a browser first to enable this app."
        case .failed:
            return "The last start attempt failed. Click to retry."
        }
    }
}
