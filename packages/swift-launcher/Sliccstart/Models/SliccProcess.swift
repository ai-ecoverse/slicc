import AppKit
import Darwin
import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "SliccProcess")

enum AppStartBlocker: Equatable {
    case needsPermission
    case needsDebugBuild

    case needsLeader
}

struct LeaderBrowserEndpoint: Equatable {
    let cdpPort: UInt16

    let appPath: String
}

enum AppRuntimeState: Equatable {
    case notRunning
    case runningWithoutDebug
    case runningWithDebug(cdpPort: UInt16?)
    case startFailed(message: String)
    case cannotStart(AppStartBlocker)

    var isRunning: Bool {
        switch self {
        case .runningWithoutDebug, .runningWithDebug:
            return true
        case .notRunning, .startFailed, .cannotStart:
            return false
        }
    }

    static func resolve(
        targetType: AppTargetType,
        debugSupport: ElectronDebugSupport = .supported,
        hasAppManagementPermission: Bool = true,
        leaderAvailable: Bool = true,
        debugPort: UInt16? = nil,
        launchFailure: String? = nil,
        appIsRunning: Bool = false
    ) -> AppRuntimeState {
        if targetType == .electronApp {
            if !hasAppManagementPermission {
                return .cannotStart(.needsPermission)
            }
            if debugSupport == .disabled {
                return .cannotStart(.needsDebugBuild)
            }
        }

        if debugPort != nil {
            return .runningWithDebug(cdpPort: debugPort)
        }

        if (targetType == .electronApp || targetType == .terminal) && !leaderAvailable {
            return .cannotStart(.needsLeader)
        }
        if targetType == .electronApp && appIsRunning {
            return .runningWithoutDebug
        }
        if let launchFailure {
            return .startFailed(message: launchFailure)
        }
        return .notRunning
    }
}

@Observable

class SliccProcess {
    struct LaunchConfiguration: Equatable {
        let executablePath: String
        let arguments: [String]
        let logLabel: String
    }

    struct SpawnServices {

        var resolveLaunchConfiguration: (_ sliccDir: String, _ extraArgs: [String]) throws -> LaunchConfiguration

        var runProcess: (Process) throws -> Void

        var isPortInUse: (UInt16) -> Bool

        static let live = SpawnServices(
            resolveLaunchConfiguration: {
                try SliccProcess.resolveLaunchConfiguration(sliccDir: $0, extraArgs: $1)
            },
            runProcess: { try $0.run() },
            isPortInUse: { SliccProcess.portIsInUse($0) }
        )
    }

    private struct LaunchRecord {
        let process: Process
        let targetType: AppTargetType
        let launchedAppPaths: [String]
        let cdpPort: UInt16
        let servePort: UInt16
        let electronAppPath: String?
        let targetName: String
        let startedAt: Date
        var observedAppPID: pid_t?

        var joinUrl: String?

        var bridgeToken: String?

        var observedCdpListening: Bool = false

        var isFollower: Bool = false
    }

    private var launchRecords: [String: LaunchRecord] = [:]
    private var startFailures: [String: String] = [:]
    private var intentionallyStoppingTargets: Set<String> = []
    private let terminalFollowerLaunchService: TerminalFollowerLaunchService

    var isLaunchingTerminalFollower = false
    var terminalCliDownloadProgress: SliccCliDownloadProgress?

    var isPreparingForUpdate = false

    var leaderJoinUrl: String?

    private var leaderProbeTask: Task<Void, Never>?

    private var hasDetached = false

    let recordStore: LaunchRecordStore
    let cdpLiveProbe: CDPLiveProbe
    let trayStatusProbe: TrayStatusProbe
    let agentActivityProbe: AgentActivityProbe
    let spawnServices: SpawnServices

    init(
        recordStore: LaunchRecordStore = LaunchRecordStore(),
        cdpLiveProbe: CDPLiveProbe = .default,
        trayStatusProbe: TrayStatusProbe = .default,
        agentActivityProbe: AgentActivityProbe = .default,
        terminalFollowerLaunchService: TerminalFollowerLaunchService = .live,
        spawnServices: SpawnServices = .live
    ) {
        self.recordStore = recordStore
        self.cdpLiveProbe = cdpLiveProbe
        self.trayStatusProbe = trayStatusProbe
        self.agentActivityProbe = agentActivityProbe
        self.terminalFollowerLaunchService = terminalFollowerLaunchService
        self.spawnServices = spawnServices
    }

    var resolvedSliccDir: String { sliccDir }
    private var sliccDir: String {

        if let env = ProcessInfo.processInfo.environment["SLICC_DIR"], !env.isEmpty {
            log.info("sliccDir: using SLICC_DIR env = \(env, privacy: .public)")
            return env
        }

        if let bundled = SliccBootstrapper.bundledSliccDir {
            log.info("sliccDir: using bundled = \(bundled, privacy: .public)")
            return bundled
        }

        let parentDir = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
        var dir = parentDir
        for _ in 0..<5 {
            if FileManager.default.fileExists(atPath: dir + "/package.json")
                && FileManager.default.fileExists(atPath: dir + "/packages/node-server/src/index.ts")
            {
                log.info("sliccDir: found source tree at \(dir, privacy: .public)")
                return dir
            }
            dir = (dir as NSString).deletingLastPathComponent
        }
        log.warning("sliccDir: falling back to default \(SliccBootstrapper.defaultSliccDir)")
        return SliccBootstrapper.defaultSliccDir
    }

    private static let browserPort: UInt16 = 5710
    private static let browserCdpPort: UInt16 = 9222
    private static let electronBasePort: UInt16 = 5711
    private static let electronBaseCdpPort: UInt16 = 9223
    private static let electronLaunchStaleTimeout: TimeInterval = 30

    private static let browserLaunchStaleTimeout: TimeInterval = 15

    func isRunning(_ target: AppTarget) -> Bool {
        runtimeState(for: target).isRunning
    }

    func runtimeState(
        for target: AppTarget,
        hasAppManagementPermission: Bool = true
    ) -> AppRuntimeState {
        let debugPort = activeDebugPort(for: target)
        let appIsRunning = target.type == .electronApp && isElectronAppRunning(target)

        let requiresLeader = target.type == .electronApp || target.type == .terminal
        let leaderAvailable = !requiresLeader || isLeaderReady()
        return AppRuntimeState.resolve(
            targetType: target.type,
            debugSupport: target.debugSupport,
            hasAppManagementPermission: hasAppManagementPermission,
            leaderAvailable: leaderAvailable,
            debugPort: debugPort,
            launchFailure: startFailures[target.id],
            appIsRunning: appIsRunning
        )
    }

    func isLeaderReady() -> Bool {
        guard let url = leaderJoinUrl, !url.isEmpty else { return false }
        return launchRecords.values.contains { $0.targetType == .chromiumBrowser && !$0.isFollower }
    }

    func hasRecentAgentActivity() async -> Bool {
        let servePorts = launchRecords.values.compactMap { record in
            record.process.isRunning ? record.servePort : nil
        }
        return await agentActivityProbe.hasRecentActivity(servePorts: servePorts)
    }

    var leaderTargetName: String? {
        launchRecords.values.first { $0.targetType == .chromiumBrowser && !$0.isFollower }?.targetName
    }

    var leaderBrowserEndpoint: LeaderBrowserEndpoint? {
        guard
            let entry = launchRecords.first(where: {
                $0.value.targetType == .chromiumBrowser && !$0.value.isFollower
            }),
            entry.value.process.isRunning,
            spawnServices.isPortInUse(entry.value.cdpPort)
        else { return nil }
        return LeaderBrowserEndpoint(cdpPort: entry.value.cdpPort, appPath: entry.key)
    }

    func isRunningAsFollower(_ target: AppTarget) -> Bool {
        guard let record = launchRecords[target.id] else { return false }
        return record.isFollower && record.process.isRunning
    }

    func refreshRuntimeStates(for targets: [AppTarget]) {
        for target in targets {
            refreshRuntimeState(for: target)
        }
    }

    func launchStandalone(_ browser: AppTarget) throws {
        refreshRuntimeState(for: browser)
        if isRunning(browser) {
            log.info("launchStandalone: \(browser.name) already running")
            return
        }
        startFailures.removeValue(forKey: browser.id)
        guard !spawnServices.isPortInUse(Self.browserPort) else { throw LaunchError.portInUse(Self.browserPort) }
        log.info("launchStandalone: \(browser.name, privacy: .public) on port \(Self.browserPort) (lead)")
        do {
            try spawn(
                target: browser,
                extraArgs: Self.standaloneBrowserArgs(
                    cdpPort: Self.browserCdpPort,
                    mounts: MountTablePreference.mappings(defaults: .standard)
                ),
                env: Self.standaloneBrowserEnv(
                    executablePath: browser.executablePath,
                    servePort: Self.browserPort,
                    inheritedEnv: ProcessInfo.processInfo.environment
                ),
                cdpPort: Self.browserCdpPort,
                servePort: Self.browserPort,
                electronAppPath: nil,

                bridgeToken: Self.standaloneBridgeToken
            )
        } catch {
            recordStartFailure(for: browser, message: error.localizedDescription)
            throw error
        }

        startLeaderProbe(servePort: Self.browserPort)
    }

    func launchBrowserFollower(_ browser: AppTarget, joinUrl: String) throws {
        guard browser.type == .chromiumBrowser else { throw LaunchError.invalidTerminalTarget }
        guard !joinUrl.isEmpty else { throw LaunchError.leaderUnavailable }
        refreshRuntimeState(for: browser)
        if isRunning(browser) {
            log.info("launchBrowserFollower: \(browser.name) already running")
            return
        }
        startFailures.removeValue(forKey: browser.id)
        let (port, cdpPort) = nextElectronPorts()
        guard !spawnServices.isPortInUse(port) else { throw LaunchError.portInUse(port) }
        log.info("launchBrowserFollower: \(browser.name, privacy: .public) on port \(port), cdp \(cdpPort) (join)")
        do {
            try spawn(
                target: browser,
                extraArgs: Self.browserFollowerArgs(cdpPort: cdpPort, joinUrl: joinUrl),
                env: Self.standaloneBrowserEnv(
                    executablePath: browser.executablePath,
                    servePort: port,
                    inheritedEnv: ProcessInfo.processInfo.environment
                ),
                cdpPort: cdpPort,
                servePort: port,
                electronAppPath: nil,
                joinUrl: joinUrl,
                bridgeToken: Self.standaloneBridgeToken,
                isFollower: true
            )
        } catch {
            recordStartFailure(for: browser, message: error.localizedDescription)
            throw error
        }
    }

    func launchWithElectronApp(_ app: AppTarget, forceRestartExistingApp: Bool = false) throws {
        refreshRuntimeState(for: app)
        if isRunning(app) {
            if case .runningWithDebug = runtimeState(for: app) {
                log.info("launchWithElectronApp: \(app.name) already running with SLICC")
                return
            }
        }
        if forceRestartExistingApp {
            terminateElectronApplications(atAppPaths: Self.relatedAppPaths(for: app))
        }
        startFailures.removeValue(forKey: app.id)
        let (port, cdpPort) = nextElectronPorts()
        guard !spawnServices.isPortInUse(port) else { throw LaunchError.portInUse(port) }
        log.info("launchWithElectronApp: \(app.name, privacy: .public) on port \(port), cdp \(cdpPort)")
        do {
            var env: [String: String] = ["PORT": "\(port)"]

            env.merge(Self.thinElectronEnv()) { _, new in new }
            try spawn(
                target: app,
                extraArgs: Self.electronAppArgs(
                    electronAppPath: app.path,
                    cdpPort: cdpPort,
                    joinUrl: leaderJoinUrl
                ),
                env: env,
                cdpPort: cdpPort,
                servePort: port,
                electronAppPath: app.path,
                joinUrl: leaderJoinUrl,

                bridgeToken: Self.thinElectronBridgeToken
            )
        } catch {
            recordStartFailure(for: app, message: error.localizedDescription)
            throw error
        }
    }

    func isTerminalCliAvailable() -> Bool {
        terminalFollowerLaunchService.isCliAvailable()
    }

    @MainActor
    func launchTerminalFollower(_ target: AppTarget, joinURLOverride: String? = nil) async throws {
        guard target.type == .terminal else { throw LaunchError.invalidTerminalTarget }
        guard !isLaunchingTerminalFollower else { return }
        let joinURL: String
        if let joinURLOverride, !joinURLOverride.isEmpty {
            joinURL = joinURLOverride
        } else {
            guard isLeaderReady(), let local = leaderJoinUrl, !local.isEmpty else {
                throw LaunchError.leaderUnavailable
            }
            joinURL = local
        }

        startFailures.removeValue(forKey: target.id)
        isLaunchingTerminalFollower = true
        terminalCliDownloadProgress = nil
        defer { isLaunchingTerminalFollower = false }

        do {
            try await terminalFollowerLaunchService.launch(
                target: target,
                joinURL: joinURL,
                progressHandler: { [weak self] progress in
                    Task { @MainActor in
                        self?.terminalCliDownloadProgress = progress
                    }
                }
            )
        } catch {
            recordStartFailure(for: target, message: error.localizedDescription)
            throw error
        }
    }

    static let defaultWorkerBaseUrl = "https://www.sliccy.ai"

    static func standaloneBrowserArgs(
        cdpPort: UInt16, mounts: [MountTablePreference.Mapping] = []
    ) -> [String] {
        ["--cdp-port=\(cdpPort)", "--lead"] + MountTablePreference.serverArgs(mappings: mounts)
    }

    static func browserFollowerArgs(cdpPort: UInt16, joinUrl: String) -> [String] {
        ["--cdp-port=\(cdpPort)", "--join=\(joinUrl)"]
    }

    static func standaloneBrowserEnv(
        executablePath: String,
        servePort: UInt16,
        inheritedEnv: [String: String],
        bridgeToken: String = standaloneBridgeToken
    ) -> [String: String] {
        let workerBaseUrl =
            inheritedEnv["WORKER_BASE_URL"]
            .flatMap { $0.isEmpty ? nil : $0 }
            ?? defaultWorkerBaseUrl
        return [
            "CHROME_PATH": executablePath,
            "PORT": "\(servePort)",
            "WORKER_BASE_URL": workerBaseUrl,

            "SLICC_BRIDGE_TOKEN": bridgeToken,
        ]
    }

    static func electronAppArgs(
        electronAppPath: String,
        cdpPort: UInt16,
        joinUrl: String?
    ) -> [String] {
        var args: [String] = [
            "--electron-app=\(electronAppPath)",
            "--kill",
            "--cdp-port=\(cdpPort)",
        ]
        if let joinUrl, !joinUrl.isEmpty {
            args.append("--join=\(joinUrl)")
        }
        return args
    }

    static let thinElectronBridgeToken: String = UUID().uuidString

    static let standaloneBridgeToken: String = UUID().uuidString

    static let defaultHostedLeaderOrigin = "https://www.sliccy.ai"

    static func resolveHostedLeaderOrigin(
        inheritedEnv: [String: String] = ProcessInfo.processInfo.environment
    ) -> String {
        let explicit = inheritedEnv["SLICC_HOSTED_LEADER_ORIGIN"] ?? inheritedEnv["WORKER_BASE_URL"]
        if let explicit, !explicit.isEmpty {
            return explicit.replacingOccurrences(
                of: #"/+$"#,
                with: "",
                options: .regularExpression
            )
        }
        return defaultHostedLeaderOrigin
    }

    static func thinElectronEnv(
        inheritedEnv: [String: String] = ProcessInfo.processInfo.environment,
        bridgeToken: String = thinElectronBridgeToken
    ) -> [String: String] {
        [
            "SLICC_HOSTED_LEADER_ORIGIN": resolveHostedLeaderOrigin(inheritedEnv: inheritedEnv),
            "SLICC_BRIDGE_TOKEN": bridgeToken,
        ]
    }

    struct LeaderProbeSnapshot: Sendable {
        let joinUrlAlreadySet: Bool
        let hasBrowserRecord: Bool
    }

    enum LeaderProbeStep: Equatable, Sendable {

        case probe

        case waitForRecord

        case stop
    }

    static let leaderProbeRecordWaitRounds = 25
    static let leaderProbeRecordWaitDelay: TimeInterval = 0.25

    static func leaderProbeStep(
        joinUrlAlreadySet: Bool,
        hasBrowserRecord: Bool,
        hasObservedBrowserRecord: Bool,
        recordWaitRoundsLeft: Int
    ) -> LeaderProbeStep {
        if joinUrlAlreadySet { return .stop }
        if hasBrowserRecord { return .probe }
        if !hasObservedBrowserRecord && recordWaitRoundsLeft > 0 { return .waitForRecord }
        return .stop
    }

    func startLeaderProbe(
        servePort: UInt16,
        innerMaxAttempts: Int = 8,
        innerRetryDelay: TimeInterval = 1.5,
        outerBackoff: TimeInterval = 2.0
    ) {
        let probe = trayStatusProbe
        let serveOrigin = "http://127.0.0.1:\(servePort)"

        let recordWaitDelay = min(outerBackoff, Self.leaderProbeRecordWaitDelay)

        leaderProbeTask?.cancel()

        leaderProbeTask = Task { [weak self] in
            var hasObservedBrowserRecord = false
            var recordWaitRoundsLeft = Self.leaderProbeRecordWaitRounds
            while !Task.isCancelled {

                let snapshot: LeaderProbeSnapshot = await MainActor.run { [weak self] in
                    guard let self else { return LeaderProbeSnapshot(joinUrlAlreadySet: true, hasBrowserRecord: false) }
                    return LeaderProbeSnapshot(
                        joinUrlAlreadySet: self.leaderJoinUrl != nil,
                        hasBrowserRecord: self.launchRecords.values.contains { $0.targetType == .chromiumBrowser }
                    )
                }
                let observed = snapshot.hasBrowserRecord
                let joinUrlAlreadySet = snapshot.joinUrlAlreadySet
                if observed { hasObservedBrowserRecord = true }
                let step = Self.leaderProbeStep(
                    joinUrlAlreadySet: joinUrlAlreadySet,
                    hasBrowserRecord: observed,
                    hasObservedBrowserRecord: hasObservedBrowserRecord,
                    recordWaitRoundsLeft: recordWaitRoundsLeft
                )
                switch step {
                case .stop:
                    log.info("startLeaderProbe: stop condition reached, exiting loop")
                    return
                case .waitForRecord:

                    recordWaitRoundsLeft -= 1
                    try? await Task.sleep(nanoseconds: UInt64(recordWaitDelay * 1_000_000_000))
                    continue
                case .probe:
                    break
                }

                let joinUrl = await probe.discoverJoinUrl(
                    serveOrigin: serveOrigin,
                    maxAttempts: innerMaxAttempts,
                    retryDelay: innerRetryDelay,
                    exhaustion: .retryable
                )
                if let joinUrl {
                    await MainActor.run { [weak self] in
                        guard let self else { return }
                        let hasBrowser = self.launchRecords.values.contains { $0.targetType == .chromiumBrowser }
                        guard hasBrowser else {
                            log.info("startLeaderProbe: discarding join URL — browser already gone")
                            return
                        }
                        guard self.leaderJoinUrl == nil else { return }
                        self.leaderJoinUrl = joinUrl
                        log.info("startLeaderProbe: leader join URL ready")
                    }
                    return
                }

                try? await Task.sleep(nanoseconds: UInt64(outerBackoff * 1_000_000_000))
            }
        }
    }

    var leaderJoinUrlWatchTask: Task<Void, Never>?

    var leaderServePort: UInt16? {
        launchRecords.values.first { $0.targetType == .chromiumBrowser && !$0.isFollower }?.servePort
    }

    private func nextElectronPorts() -> (port: UInt16, cdpPort: UInt16) {
        let electronCount = UInt16(launchRecords.count)
        for i: UInt16 in 0...20 {
            let port = Self.electronBasePort + electronCount + i
            let cdpPort = Self.electronBaseCdpPort + electronCount + i
            if !spawnServices.isPortInUse(port) && !spawnServices.isPortInUse(cdpPort) {
                return (port, cdpPort)
            }
        }

        let port = Self.electronBasePort + electronCount
        return (port, Self.electronBaseCdpPort + electronCount)
    }

    static let chromeWebStoreURL = "https://chromewebstore.google.com/detail/slicc/akjjllgokmbgpbdbmafpiefnhidlmbgf"

    func openChromeWebStore() {
        guard let url = URL(string: Self.chromeWebStoreURL) else { return }
        if let chromeURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
            log.info("openChromeWebStore: opening in Chrome")
            NSWorkspace.shared.open([url], withApplicationAt: chromeURL, configuration: NSWorkspace.OpenConfiguration())
        } else {
            log.warning("openChromeWebStore: Chrome not found, opening in default browser")
            NSWorkspace.shared.open(url)
        }
    }

    func stop(_ target: AppTarget) {
        log.info("stop: \(target.name)")
        stopLaunchRecord(id: target.id, terminateApps: true)
        startFailures.removeValue(forKey: target.id)
    }

    func stopAll() {
        log.info("stopAll: terminating \(self.launchRecords.count) processes")
        for id in Array(launchRecords.keys) {
            stopLaunchRecord(id: id, terminateApps: true)
        }
        startFailures.removeAll()
        leaderJoinUrl = nil
    }

    private func clearLeaderIfNoBrowserRunning() {
        let hasBrowser = launchRecords.values.contains { $0.targetType == .chromiumBrowser && !$0.isFollower }
        if !hasBrowser {
            leaderJoinUrl = nil
        }
    }

    @discardableResult

    func _testing_seedLaunchRecord(
        id: String,
        process: Process,
        targetType: AppTargetType,
        launchedAppPaths: [String] = [],
        cdpPort: UInt16,
        servePort: UInt16,
        electronAppPath: String? = nil,
        targetName: String,
        joinUrl: String? = nil,
        bridgeToken: String? = nil,
        startedAt: Date = Date(),
        observedCdpListening: Bool = false,
        isFollower: Bool = false
    ) {
        launchRecords[id] = LaunchRecord(
            process: process,
            targetType: targetType,
            launchedAppPaths: launchedAppPaths,
            cdpPort: cdpPort,
            servePort: servePort,
            electronAppPath: electronAppPath,
            targetName: targetName,
            startedAt: startedAt,
            observedAppPID: nil,
            joinUrl: joinUrl,
            bridgeToken: bridgeToken,
            observedCdpListening: observedCdpListening,
            isFollower: isFollower
        )
    }

    @discardableResult
    func detachAll() -> [PersistedLaunchRecord] {

        if hasDetached {
            log.info("detachAll: already detached; returning persisted snapshot")
            return recordStore.load()
        }
        hasDetached = true
        let snapshot = launchRecords.compactMap { id, record -> PersistedLaunchRecord? in
            guard record.process.isRunning else { return nil }

            guard !record.isFollower else { return nil }
            return PersistedLaunchRecord(
                targetId: id,
                targetName: record.targetName,
                targetType: record.targetType,
                electronAppPath: record.electronAppPath,
                servePort: record.servePort,
                cdpPort: record.cdpPort,
                joinUrl: record.joinUrl,
                bridgeToken: record.bridgeToken
            )
        }
        do {
            try recordStore.save(snapshot)
        } catch {
            log.error("detachAll: failed to persist records: \(error.localizedDescription, privacy: .public)")

            LauncherErrorReport.report(.updateDetach, error)
        }

        log.info("detachAll: detaching \(self.launchRecords.count) processes")
        for id in Array(launchRecords.keys) {
            detachLaunchRecord(id: id)
        }
        startFailures.removeAll()
        return snapshot
    }

    @discardableResult
    func reattachPersistedRecords(targets: [AppTarget]) async -> [String] {
        let records = recordStore.load()
        guard !records.isEmpty else { return [] }
        let targetsById = Dictionary(uniqueKeysWithValues: targets.map { ($0.id, $0) })

        var reattached: [String] = []
        for record in records {
            guard let target = targetsById[record.targetId] else {
                log.info("reattach: skipping \(record.targetName, privacy: .public) — target no longer present in scan")
                continue
            }
            let isAlive = await cdpLiveProbe.isAlive(cdpPort: record.cdpPort)
            guard isAlive else {
                log.info("reattach: skipping \(record.targetName, privacy: .public) — CDP \(record.cdpPort) not responding")
                continue
            }
            do {
                try reattach(target: target, record: record)
                reattached.append(record.targetId)
            } catch {
                log.error("reattach: failed for \(record.targetName, privacy: .public): \(error.localizedDescription, privacy: .public)")
                LauncherErrorReport.report(.reattach, error)
            }
        }
        recordStore.clear()
        return reattached
    }

    static func reattachArgs(
        targetType: AppTargetType,
        electronAppPath: String?,
        cdpPort: UInt16,
        joinUrl: String?,
        mounts: [MountTablePreference.Mapping] = []
    ) -> [String] {
        var args: [String] = [
            "--serve-only",
            "--cdp-port=\(cdpPort)",
        ]

        if targetType == .chromiumBrowser {
            args.append(contentsOf: MountTablePreference.serverArgs(mappings: mounts))
        }
        if targetType == .electronApp {
            if let electronAppPath {
                args.append("--electron-app=\(electronAppPath)")
            }
            args.append("--electron")
            if let joinUrl, !joinUrl.isEmpty {
                args.append("--join=\(joinUrl)")
            }
        }
        return args
    }

    private func reattach(target: AppTarget, record: PersistedLaunchRecord) throws {

        guard !spawnServices.isPortInUse(record.servePort) else {
            throw LaunchError.portInUse(record.servePort)
        }
        let extraArgs = Self.reattachArgs(
            targetType: target.type,
            electronAppPath: target.type == .electronApp ? target.path : nil,
            cdpPort: record.cdpPort,
            joinUrl: record.joinUrl,
            mounts: MountTablePreference.mappings(defaults: .standard)
        )

        let fallbackToken =
            target.type == .chromiumBrowser
            ? Self.standaloneBridgeToken
            : Self.thinElectronBridgeToken
        let resolvedBridgeToken = record.bridgeToken ?? fallbackToken
        var env: [String: String] = ["PORT": "\(record.servePort)"]
        if target.type == .chromiumBrowser {
            env["CHROME_PATH"] = target.executablePath

            env["SLICC_BRIDGE_TOKEN"] = resolvedBridgeToken
        }
        if target.type == .electronApp {

            env.merge(Self.thinElectronEnv(bridgeToken: resolvedBridgeToken)) { _, new in new }
        }
        try spawn(
            target: target,
            extraArgs: extraArgs,
            env: env,
            cdpPort: record.cdpPort,
            servePort: record.servePort,
            electronAppPath: record.electronAppPath,
            joinUrl: record.joinUrl,

            bridgeToken: resolvedBridgeToken
        )

        if target.type == .chromiumBrowser {
            startLeaderProbe(servePort: record.servePort)
        }
    }

    static func resolveLaunchConfiguration(
        sliccDir: String,
        extraArgs: [String],
        resourcePath: String? = Bundle.main.resourcePath
    ) throws -> LaunchConfiguration {
        if let serverBinary = SliccBootstrapper.findServerBinary(
            sliccDir: sliccDir,
            resourcePath: resourcePath
        ) {
            return LaunchConfiguration(
                executablePath: serverBinary,
                arguments: extraArgs,
                logLabel: "server"
            )
        }

        log.error("resolveLaunchConfiguration: slicc-server binary not found")
        throw LaunchError.serverBinaryNotFound
    }

    private func spawn(
        target: AppTarget,
        extraArgs: [String],
        env: [String: String],
        cdpPort: UInt16,
        servePort: UInt16,
        electronAppPath: String?,
        joinUrl: String? = nil,
        bridgeToken: String? = nil,
        isFollower: Bool = false
    ) throws {
        let launchConfig = try spawnServices.resolveLaunchConfiguration(sliccDir, extraArgs)
        let loggedArguments = Self.redactedSpawnArguments(launchConfig.arguments).joined(separator: " ")
        log.info("spawn: \(launchConfig.executablePath, privacy: .public) \(loggedArguments, privacy: .public)")
        log.info("spawn: cwd = \(self.sliccDir, privacy: .public)")

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchConfig.executablePath)
        proc.arguments = launchConfig.arguments
        proc.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            for l in line.split(separator: "\n", omittingEmptySubsequences: true) {
                log.info("[\(launchConfig.logLabel, privacy: .public)/\(target.name, privacy: .public)] \(l, privacy: .public)")
            }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            for l in line.split(separator: "\n", omittingEmptySubsequences: true) {
                log.error("[\(launchConfig.logLabel, privacy: .public)/\(target.name, privacy: .public)] \(l, privacy: .public)")
            }
        }

        proc.terminationHandler = { [weak self] p in
            log.info("process exited: \(target.name, privacy: .public) code=\(p.terminationStatus)")

            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self else { return }
                let wasIntentional = self.intentionallyStoppingTargets.remove(target.id) != nil
                let isCurrentRecord = self.launchRecords[target.id]?.process === p
                if isCurrentRecord {
                    self.launchRecords.removeValue(forKey: target.id)
                    if target.type == .chromiumBrowser {
                        self.clearLeaderIfNoBrowserRunning()
                    }
                }
                if !wasIntentional && p.terminationStatus != 0 && isCurrentRecord {
                    self.recordStartFailure(
                        for: target,
                        message: "SLICC exited with code \(p.terminationStatus)."
                    )
                }
            }
        }
        try spawnServices.runProcess(proc)
        log.info("spawn: pid=\(proc.processIdentifier) for \(target.name, privacy: .public)")
        launchRecords[target.id] = LaunchRecord(
            process: proc,
            targetType: target.type,
            launchedAppPaths: target.type == .electronApp ? Self.launchedAppPaths(for: target) : [],
            cdpPort: cdpPort,
            servePort: servePort,
            electronAppPath: electronAppPath,
            targetName: target.name,
            startedAt: Date(),
            observedAppPID: nil,
            joinUrl: joinUrl,
            bridgeToken: bridgeToken,
            isFollower: isFollower
        )
    }

    static func redactedSpawnArguments(_ arguments: [String]) -> [String] {
        var redactNextValue = false
        return arguments.map { argument in
            if redactNextValue {
                redactNextValue = false
                return "<redacted>"
            }

            let parts = argument.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let option = parts[0].lowercased()
            let isSensitive =
                option.hasPrefix("--")
                && (option.contains("join") || option.contains("token"))
            guard isSensitive else { return argument }
            guard parts.count == 2 else {
                redactNextValue = true
                return argument
            }
            return "\(parts[0])=<redacted>"
        }
    }

    private func refreshRuntimeState(for target: AppTarget) {
        guard var record = launchRecords[target.id] else { return }
        guard record.process.isRunning else {
            launchRecords.removeValue(forKey: target.id)
            return
        }

        if record.targetType == .chromiumBrowser {
            if spawnServices.isPortInUse(record.cdpPort) {
                record.observedCdpListening = true
                launchRecords[target.id] = record
                return
            }
            if record.observedCdpListening,
                Date().timeIntervalSince(record.startedAt) > Self.browserLaunchStaleTimeout
            {
                log.info("refreshRuntimeState: \(target.name, privacy: .public) browser CDP port went away after booting; stopping stale helper")
                stopLaunchRecord(id: target.id, terminateApps: false)
            }
            return
        }

        guard record.targetType == .electronApp else {
            return
        }

        if let observedAppPID = record.observedAppPID, Self.isPIDRunning(observedAppPID) {
            return
        }
        let runningApps = runningElectronApplications(for: target)
        if let app = runningApps.first {
            record.observedAppPID = app.processIdentifier
            launchRecords[target.id] = record
            return
        }

        guard let observedAppPID = record.observedAppPID else {
            if Date().timeIntervalSince(record.startedAt) > Self.electronLaunchStaleTimeout,
                !spawnServices.isPortInUse(record.cdpPort)
            {
                log.info("refreshRuntimeState: \(target.name, privacy: .public) has no app pid or CDP listener; stopping stale helper")
                stopLaunchRecord(id: target.id, terminateApps: false)
                return
            }
            return
        }

        if !Self.isPIDRunning(observedAppPID) {
            log.info("refreshRuntimeState: \(target.name, privacy: .public) app pid \(observedAppPID) exited; stopping helper")
            stopLaunchRecord(id: target.id, terminateApps: false)
        }
    }

    private func activeDebugPort(for target: AppTarget) -> UInt16? {
        guard let record = launchRecords[target.id], record.process.isRunning else {
            return nil
        }
        if record.targetType == .electronApp,
            !spawnServices.isPortInUse(record.cdpPort)
        {
            return nil
        }
        if record.targetType == .electronApp,
            let observedAppPID = record.observedAppPID,
            !Self.isPIDRunning(observedAppPID),
            !isElectronAppRunning(target)
        {
            return nil
        }
        return record.cdpPort
    }

    private func stopLaunchRecord(id: String, terminateApps: Bool) {
        guard let record = launchRecords.removeValue(forKey: id) else {
            intentionallyStoppingTargets.remove(id)
            return
        }

        intentionallyStoppingTargets.insert(id)
        if terminateApps {
            terminateElectronApplications(atAppPaths: record.launchedAppPaths)
        }
        if record.process.isRunning {
            record.process.terminate()
        } else {
            intentionallyStoppingTargets.remove(id)
        }
        if record.targetType == .chromiumBrowser {
            clearLeaderIfNoBrowserRunning()
        }
    }

    private func detachLaunchRecord(id: String) {
        guard let record = launchRecords.removeValue(forKey: id) else {
            intentionallyStoppingTargets.remove(id)
            return
        }

        intentionallyStoppingTargets.insert(id)
        if record.process.isRunning {
            let pid = record.process.processIdentifier
            if pid > 0 {
                _ = Darwin.kill(pid, SIGUSR1)
            }

            let deadline = Date().addingTimeInterval(1.5)
            while record.process.isRunning && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if record.process.isRunning {
                log.info("detachLaunchRecord: SIGUSR1 ignored, falling back to terminate() for \(record.targetName, privacy: .public)")
                record.process.terminate()
            }
        } else {
            intentionallyStoppingTargets.remove(id)
        }
    }

    private func recordStartFailure(for target: AppTarget, message: String) {
        startFailures[target.id] = message
    }

    private func isElectronAppRunning(_ target: AppTarget) -> Bool {

        if let observedAppPID = launchRecords[target.id]?.observedAppPID,
            Self.isPIDRunning(observedAppPID)
        {
            return true
        }
        return !runningElectronApplications(for: target).isEmpty
    }

    private func runningElectronApplications(for target: AppTarget) -> [NSRunningApplication] {
        Self.runningElectronApplications(atAppPaths: Self.relatedAppPaths(for: target))
    }

    private func terminateElectronApplications(atAppPaths appPaths: [String]) {
        for app in Self.runningElectronApplications(atAppPaths: appPaths) {
            log.info("terminating app: \(app.localizedName ?? app.bundleURL?.path ?? "unknown", privacy: .public)")
            app.terminate()
        }
    }

    static func launchedAppPaths(for target: AppTarget) -> [String] {
        [target.path]
    }

    static func relatedAppPaths(for target: AppTarget) -> [String] {
        var paths = [target.path]
        if let originalAppPath = target.originalAppPath, originalAppPath != target.path {
            paths.append(originalAppPath)
        }
        return paths
    }

    private static func runningElectronApplications(atAppPaths appPaths: [String]) -> [NSRunningApplication] {
        let candidates = candidateBundlePaths(for: appPaths)
        return NSWorkspace.shared.runningApplications.filter { app in
            guard !app.isTerminated else { return false }
            return appMatches(
                bundlePath: app.bundleURL?.path,
                executablePath: app.executableURL?.path,
                candidateBundlePaths: candidates
            )
        }
    }

    static func candidateBundlePaths(for appPaths: [String]) -> Set<String> {
        var candidates = Set<String>()
        for path in appPaths {
            let expanded = NSString(string: path).expandingTildeInPath
            let url = URL(fileURLWithPath: expanded)
            for variant in [expanded, url.standardizedFileURL.path, standardizedFileURL(path: path).path] {
                candidates.insert(stripTrailingSlash(variant))
            }
        }
        return candidates
    }

    static func appMatches(
        bundlePath: String?,
        executablePath: String?,
        candidateBundlePaths: Set<String>
    ) -> Bool {
        if let bundlePath, candidateBundlePaths.contains(stripTrailingSlash(bundlePath)) {
            return true
        }
        if let executablePath {
            return candidateBundlePaths.contains { executablePath.hasPrefix($0 + "/Contents/MacOS/") }
        }
        return false
    }

    private static func stripTrailingSlash(_ path: String) -> String {
        path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
    }

    private static func standardizedFileURL(path: String) -> URL {
        URL(fileURLWithPath: NSString(string: path).expandingTildeInPath)
            .standardizedFileURL
            .resolvingSymlinksInPath()
    }

    private static func isPIDRunning(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 {
            return true
        }
        return errno == EPERM
    }

    static func portIsInUse(_ port: UInt16) -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        defer { close(sock) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(sock, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    enum LaunchError: LocalizedError {
        case serverBinaryNotFound
        case portInUse(UInt16)
        case invalidTerminalTarget
        case leaderUnavailable
        var errorDescription: String? {
            switch self {
            case .serverBinaryNotFound: return "SLICC server binary not found. Build or bundle slicc-server before launching."
            case .portInUse(let port): return "Port \(port) is already in use."
            case .invalidTerminalTarget: return "The selected app is not a supported terminal."
            case .leaderUnavailable: return "Start a browser session before opening a terminal follower."
            }
        }
    }
}
