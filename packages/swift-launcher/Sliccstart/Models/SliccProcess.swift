import AppKit
import Darwin
import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "SliccProcess")

enum AppStartBlocker: Equatable {
    case needsPermission
    case needsDebugBuild
    /// Electron apps require an already-running leader browser so the
    /// follower has a tray join URL to attach to. While no leader is
    /// available we surface this blocker so the UI can disable the row
    /// with a "Start a browser first" hint instead of failing the launch.
    case needsLeader
}

/// A running leader browser addressed by both halves callers need: the CDP
/// port to talk to and the app bundle that owns it. Keeping them together
/// stops a caller from talking to one browser while bringing another forward
/// (the leader is not necessarily the head of the reorderable Browsers list —
/// the user can start any of them by hand).
struct LeaderBrowserEndpoint: Equatable {
    let cdpPort: UInt16
    /// Bundle path (`AppTarget.id`) of the browser owning `cdpPort`.
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
        // Gate Electron rows on the presence of a leader join URL. Once
        // attached (debugPort set above) we no longer care — the follower
        // is already wired into the leader and surviving the leader going
        // away is a separate problem.
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
/// Not `final`: the launcher's window model drives this type for every
/// side effect it has (spawning browsers, detaching for an update, probing
/// agent activity), so a test needs to stand in for it. `@testable` makes an
/// internal, non-final class overridable from the test target.
class SliccProcess {
    struct LaunchConfiguration: Equatable {
        let executablePath: String
        let arguments: [String]
        let logLabel: String
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
        /// Leader join URL captured at launch time (Electron followers
        /// only — nil for chromiumBrowser). Copied into
        /// `PersistedLaunchRecord` so reattach can re-thread `--join`
        /// across a smooth update.
        var joinUrl: String?
        /// Launcher-scoped `/cdp` bridge token this runtime was launched
        /// with. Copied into `PersistedLaunchRecord` so reattach across a
        /// full-app update re-forwards the SAME secret the still-running
        /// browser tab carries in its launch URL.
        var bridgeToken: String?
        /// Set true the first time this browser's CDP port is observed
        /// listening. The stale-helper reap only fires once CDP has been
        /// seen (browser finished booting) and then goes away — so a
        /// still-booting browser (slow Keychain prompt, cold start) whose
        /// CDP port has not come up yet is never prematurely reaped.
        var observedCdpListening: Bool = false
        /// True for a chromium browser launched with `--join` to attach to a
        /// *remote* tray as a follower. Such a record is not a local leader,
        /// so it is excluded from `isLeaderReady`, leader-URL clearing, and
        /// the smooth-update reattach snapshot.
        var isFollower: Bool = false
    }

    /// SLICC helper/server processes keyed by AppTarget.id.
    private var launchRecords: [String: LaunchRecord] = [:]
    private var startFailures: [String: String] = [:]
    private var intentionallyStoppingTargets: Set<String> = []
    private let terminalFollowerLaunchService: TerminalFollowerLaunchService

    var isLaunchingTerminalFollower = false
    var terminalCliDownloadProgress: SliccCliDownloadProgress?

    /// Set by the AppUpdater install flow so `applicationWillTerminate`
    /// takes the detach path (browsers survive, records persisted) instead
    /// of the legacy stopAll() path.
    var isPreparingForUpdate = false

    /// Tray join URL discovered from the running leader browser via
    /// `/api/tray-status`. `nil` until the probe completes (or while
    /// no leader is running); follower Electron apps are launched with
    /// `--join=<this URL>` so they auto-attach as followers. Cleared
    /// when no chromiumBrowser record remains so the Desktop App rows
    /// re-gate after the user closes the leader.
    var leaderJoinUrl: String?

    /// Active re-probe loop. Cancelled and replaced on every
    /// `startLeaderProbe` invocation so launch + reattach (or repeated
    /// launches) don't stack concurrent loops. The loop exits on its
    /// own when the chromiumBrowser record goes away or `leaderJoinUrl`
    /// is set, so callers rarely need to cancel explicitly.
    private var leaderProbeTask: Task<Void, Never>?

    /// One-shot latch tracking whether `detachAll()` already ran. The
    /// full-app update path calls it from `onBeginUpdate` and the
    /// delegate calls it again from `applicationWillTerminate`; without
    /// this guard the second call would persist an empty snapshot
    /// (because the first call cleared `launchRecords`) and erase the
    /// reattach data the next launch needs.
    private var hasDetached = false

    let recordStore: LaunchRecordStore
    let cdpLiveProbe: CDPLiveProbe
    let trayStatusProbe: TrayStatusProbe
    let agentActivityProbe: AgentActivityProbe

    init(
        recordStore: LaunchRecordStore = LaunchRecordStore(),
        cdpLiveProbe: CDPLiveProbe = .default,
        trayStatusProbe: TrayStatusProbe = .default,
        agentActivityProbe: AgentActivityProbe = .default,
        terminalFollowerLaunchService: TerminalFollowerLaunchService = .live
    ) {
        self.recordStore = recordStore
        self.cdpLiveProbe = cdpLiveProbe
        self.trayStatusProbe = trayStatusProbe
        self.agentActivityProbe = agentActivityProbe
        self.terminalFollowerLaunchService = terminalFollowerLaunchService
    }

    var resolvedSliccDir: String { sliccDir }
    private var sliccDir: String {
        // Priority 1: SLICC_DIR env var (development override)
        if let env = ProcessInfo.processInfo.environment["SLICC_DIR"], !env.isEmpty {
            log.info("sliccDir: using SLICC_DIR env = \(env, privacy: .public)")
            return env
        }
        // Priority 2: Bundled inside the .app (production)
        if let bundled = SliccBootstrapper.bundledSliccDir {
            log.info("sliccDir: using bundled = \(bundled, privacy: .public)")
            return bundled
        }
        // Priority 3: Walk up from bundle location (development — running from source tree)
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

    /// Port allocation: browser gets 5710, electron apps get 5711, 5712, ...
    /// CDP ports: browser gets 9222, electron apps get 9223, 9224, ...
    private static let browserPort: UInt16 = 5710
    private static let browserCdpPort: UInt16 = 9222
    private static let electronBasePort: UInt16 = 5711
    private static let electronBaseCdpPort: UInt16 = 9223
    private static let electronLaunchStaleTimeout: TimeInterval = 30
    /// Grace period before a `chromiumBrowser` record is validated for
    /// browser liveness. Comfortably above normal Chrome/CDP boot time so a
    /// browser that is still booting (CDP not up yet) is not reaped.
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
        // Browser rows never gate on leader availability; for Electron
        // followers the row stays disabled until we have both a running
        // browser leader and a discovered join URL.
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

    /// `true` when a chromiumBrowser launch record is alive AND the
    /// tray-status probe has successfully read a join URL from it.
    /// Both halves matter: a browser without a tray can't host followers,
    /// and a stale join URL (no live browser) would route to a dead leader.
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

    /// Display name of the running chromium leader, if any. Used to label
    /// this device's session when it is advertised for cross-device sync.
    var leaderTargetName: String? {
        launchRecords.values.first { $0.targetType == .chromiumBrowser && !$0.isFollower }?.targetName
    }

    /// The running local leader browser's CDP endpoint, or `nil` while none is
    /// up. Unlike `isLeaderReady()` this does not wait for a tray join URL:
    /// opening a plain link as a tab (the default-browser role) only needs the
    /// browser itself, which the listening CDP port proves.
    var leaderBrowserEndpoint: LeaderBrowserEndpoint? {
        guard
            let entry = launchRecords.first(where: {
                $0.value.targetType == .chromiumBrowser && !$0.value.isFollower
            }),
            entry.value.process.isRunning,
            Self.isPortInUse(entry.value.cdpPort)
        else { return nil }
        return LeaderBrowserEndpoint(cdpPort: entry.value.cdpPort, appPath: entry.key)
    }

    /// True when `target` is occupied by a launch record that can never become
    /// this device's leader: a browser attached to a *remote* tray with
    /// `--join`. `launchStandalone` no-ops on such a browser ("already
    /// running") while `leaderBrowserEndpoint` keeps ignoring it, so a caller
    /// waiting for a leader has to move on to the next browser instead of
    /// retrying this one.
    func isRunningAsFollower(_ target: AppTarget) -> Bool {
        guard let record = launchRecords[target.id] else { return false }
        return record.isFollower && record.process.isRunning
    }

    func refreshRuntimeStates(for targets: [AppTarget]) {
        for target in targets {
            refreshRuntimeState(for: target)
        }
    }

    // MARK: - Browser mode

    func launchStandalone(_ browser: AppTarget) throws {
        refreshRuntimeState(for: browser)
        if isRunning(browser) {
            log.info("launchStandalone: \(browser.name) already running")
            return
        }
        startFailures.removeValue(forKey: browser.id)
        guard !Self.isPortInUse(Self.browserPort) else { throw LaunchError.portInUse(Self.browserPort) }
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
                // Persist the launcher-scoped token so a later reattach across
                // a full-app update re-forwards the SAME secret the surviving
                // browser tab carries in its launch URL.
                bridgeToken: Self.standaloneBridgeToken
            )
        } catch {
            recordStartFailure(for: browser, message: error.localizedDescription)
            throw error
        }
        // Probe the just-spawned leader for its tray join URL. Runs on a
        // detached Task so the launch call stays non-blocking; failures
        // are logged and leave `leaderJoinUrl` nil so the UI keeps the
        // Desktop App rows disabled rather than wiring followers to a
        // dead URL.
        startLeaderProbe(servePort: Self.browserPort)
    }

    // MARK: - Browser follower mode (attach a browser to a remote tray)

    /// Launch a chromium browser as a *follower* attached to a remote tray
    /// discovered via iCloud sync. Uses `--join=<url>` and its own port pair
    /// so it can coexist with a local leader; the record is flagged
    /// `isFollower` so it never counts as this device's leader.
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
        guard !Self.isPortInUse(port) else { throw LaunchError.portInUse(port) }
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

    // MARK: - Electron mode (each app gets its own port)

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
        guard !Self.isPortInUse(port) else { throw LaunchError.portInUse(port) }
        log.info("launchWithElectronApp: \(app.name, privacy: .public) on port \(port), cdp \(cdpPort)")
        do {
            var env: [String: String] = ["PORT": "\(port)"]
            // Activate thin-Electron mode in the child (Path B overlay +
            // /cdp gate). Mirrors node-server's `electron-main.ts`
            // env-forwarding shape; harmless to set unconditionally — the
            // child only acts on these vars when `--electron` is on.
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
                // Persist the launcher-scoped token so reattach across a
                // full-app update re-arms the child's `/cdp` gate with the
                // same secret instead of a freshly-minted one.
                bridgeToken: Self.thinElectronBridgeToken
            )
        } catch {
            recordStartFailure(for: app, message: error.localizedDescription)
            throw error
        }
    }

    // MARK: - Terminal follower mode

    func isTerminalCliAvailable() -> Bool {
        terminalFollowerLaunchService.isCliAvailable()
    }

    /// Attach a terminal follower to a leader. With no `joinURLOverride`
    /// the local leader's `leaderJoinUrl` is used (the existing single-Mac
    /// flow). A non-empty override attaches to a *remote* leader discovered
    /// via iCloud sync, so the local-leader readiness gate is skipped.
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

    /// Default worker base URL handed to swift-server when the user has
    /// not overridden `WORKER_BASE_URL`. Mirrors swift-server's non-dev
    /// default in `APIRoutes.swift` so the same fallback applies whether
    /// the launch flag is read at CLI parse time or at runtime-config
    /// time.
    // MUST match SLICC_HOSTED_ORIGIN in packages/shared-ts/src/bridge-protocol.ts
    static let defaultWorkerBaseUrl = "https://www.sliccy.ai"

    /// Browser-launch extra args. Always `--lead` so swift-server mints
    /// a tray; the worker base URL is sourced from the environment in
    /// `standaloneBrowserEnv` so we don't have to duplicate the
    /// scheme/host shape on the CLI.
    static func standaloneBrowserArgs(
        cdpPort: UInt16, mounts: [MountTablePreference.Mapping] = []
    ) -> [String] {
        ["--cdp-port=\(cdpPort)", "--lead"] + MountTablePreference.serverArgs(mappings: mounts)
    }

    /// Browser-follower extra args: `--join=<url>` instead of `--lead`, so
    /// swift-server hands the join URL to the webapp and the browser attaches
    /// to a remote tray as a follower rather than minting its own.
    static func browserFollowerArgs(cdpPort: UInt16, joinUrl: String) -> [String] {
        ["--cdp-port=\(cdpPort)", "--join=\(joinUrl)"]
    }

    /// Environment for the browser launch. Preserves user-supplied
    /// `WORKER_BASE_URL` and otherwise defaults to `defaultWorkerBaseUrl`
    /// so `swift-server --lead` always has a tray endpoint to point the
    /// webapp at.
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
            // Forward a launcher-scoped bridge token so swift-server mounts
            // thin-bridge CORS and gates `/cdp` from first launch — and so a
            // later `--serve-only` reattach (which re-forwards the same token)
            // keeps the hosted page able to reach `/api/*`. Mirrors the
            // thin-Electron token forwarding in `thinElectronEnv`.
            "SLICC_BRIDGE_TOKEN": bridgeToken,
        ]
    }

    /// Electron-launch extra args. When `joinUrl` is non-nil the spawned
    /// slicc-server hands `--join=<url>` to the webapp so it attaches to
    /// the running leader as a follower instead of minting its own tray.
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

    /// Per-launcher thin-Electron bridge token, minted once at first read.
    /// Forwarded to every spawned slicc-server `--electron` child as
    /// `SLICC_BRIDGE_TOKEN` so a single launcher-scoped secret gates every
    /// child's `/cdp` upgrade. Mirrors node-server's `electron-main.ts`
    /// per-process `BRIDGE_TOKEN` mint. Same launcher run ↔ same token,
    /// so reattach across smooth updates keeps the same gate value.
    static let thinElectronBridgeToken: String = UUID().uuidString

    /// Per-launcher standalone-browser bridge token, minted once at first
    /// read. Forwarded to the standalone Chromium leader (and re-forwarded on
    /// `--serve-only` reattach) as `SLICC_BRIDGE_TOKEN` so the same
    /// launcher-scoped secret gates `/cdp` and authorizes cross-origin
    /// `/api/*` from the hosted page across a full-app-update binary swap.
    /// Same launcher run ↔ same token, so the still-running browser keeps
    /// matching the gate after the slicc-server is re-spawned.
    static let standaloneBridgeToken: String = UUID().uuidString

    /// Default hosted leader origin handed to the thin-Electron child when
    /// no explicit override is present. Mirrors swift-server's non-dev
    /// default in `resolveHostedLeaderOrigin` so the env vars Sliccstart
    /// sets match the value the child would otherwise compute.
    // MUST match SLICC_HOSTED_ORIGIN in packages/shared-ts/src/bridge-protocol.ts
    static let defaultHostedLeaderOrigin = "https://www.sliccy.ai"

    /// Resolve the hosted leader origin to forward to slicc-server. Prefers
    /// an explicit `SLICC_HOSTED_LEADER_ORIGIN`, then `WORKER_BASE_URL`, and
    /// otherwise defaults to production sliccy.ai. Trailing slashes are
    /// stripped so callers can safely concatenate paths. Mirrors swift-
    /// server's `resolveHostedLeaderOrigin` byte-for-byte.
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

    /// Env additions that activate thin-Electron mode in the spawned
    /// slicc-server `--electron` child. Applied in both `launchWithElectronApp`
    /// and the electron `reattach` path so the gate stays armed across
    /// smooth updates. Mirrors node-server's `electron-main.ts` env shape:
    /// `SLICC_HOSTED_LEADER_ORIGIN` is the opt-in signal, `SLICC_BRIDGE_TOKEN`
    /// is the per-launcher secret the child reads instead of minting its own.
    static func thinElectronEnv(
        inheritedEnv: [String: String] = ProcessInfo.processInfo.environment,
        bridgeToken: String = thinElectronBridgeToken
    ) -> [String: String] {
        [
            "SLICC_HOSTED_LEADER_ORIGIN": resolveHostedLeaderOrigin(inheritedEnv: inheritedEnv),
            "SLICC_BRIDGE_TOKEN": bridgeToken,
        ]
    }

    /// Main-actor state the probe loop reads once per round.
    struct LeaderProbeSnapshot: Sendable {
        let joinUrlAlreadySet: Bool
        let hasBrowserRecord: Bool
    }

    /// What the probe loop does next for a given round.
    enum LeaderProbeStep: Equatable, Sendable {
        /// A chromiumBrowser record is live — poll `/api/tray-status`.
        case probe
        /// The record hasn't been registered yet (startup race) — back off
        /// briefly and re-check instead of exiting.
        case waitForRecord
        /// Nothing left to do: the URL landed elsewhere, or a record we had
        /// already seen went away.
        case stop
    }

    /// How many rounds the loop waits for a launch record that has never
    /// appeared before giving up, and how long each of those rounds waits.
    /// ~6 s total in production — long enough to cover the spawn that
    /// follows `startLeaderProbe`, short enough that a failed spawn does
    /// not leave a loop running.
    static let leaderProbeRecordWaitRounds = 25
    static let leaderProbeRecordWaitDelay: TimeInterval = 0.25

    /// Pure decision table for one round of `startLeaderProbe`.
    ///
    /// The `hasObservedBrowserRecord` distinction is the whole point: a
    /// missing record *after* one was seen means the browser closed (stop),
    /// but a missing record *before* any was seen means the caller hasn't
    /// finished spawning yet. `reattach` calls `startLeaderProbe` from a
    /// non-main-actor context, so treating that as terminal left
    /// `leaderJoinUrl` nil for the whole session after a smooth update —
    /// which disabled every Electron/terminal row ("Start a browser first")
    /// and suppressed iCloud session advertising.
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

    /// Fire-and-forget tray-status probe that keeps trying until the
    /// leader is actually ready. The bounded `discoverJoinUrl` retry
    /// only covers a ~10s window, so when Chrome auto-launches at
    /// startup the tray often isn't minted in time and a one-shot probe
    /// would leave `leaderJoinUrl` permanently nil. This outer loop
    /// re-schedules `discoverJoinUrl` until (a) it returns a URL while
    /// the chromiumBrowser record is still alive, (b) the browser
    /// record goes away, or (c) `leaderJoinUrl` is set by another path
    /// (e.g. a parallel call). Cancels any prior loop so launch +
    /// reattach don't stack.
    ///
    /// `innerMaxAttempts`/`innerRetryDelay`/`outerBackoff` exist only so
    /// unit tests can drive the loop quickly; production callers omit
    /// them and inherit the defaults.
    func startLeaderProbe(
        servePort: UInt16,
        innerMaxAttempts: Int = 8,
        innerRetryDelay: TimeInterval = 1.5,
        outerBackoff: TimeInterval = 2.0
    ) {
        let probe = trayStatusProbe
        let serveOrigin = "http://127.0.0.1:\(servePort)"
        // Cap the "record hasn't appeared yet" wait so a caller that
        // starts the probe and then fails to spawn cannot leave the loop
        // spinning forever.
        let recordWaitDelay = min(outerBackoff, Self.leaderProbeRecordWaitDelay)

        leaderProbeTask?.cancel()
        // Capture `self` weakly into the detached Task, then hop to the
        // main actor and re-derive a strong reference there. Doing the
        // re-derive inside `MainActor.run` (rather than the outer Task
        // closure) avoids the Swift 6 sendable-capture warning about
        // mutating a captured `var self` from a concurrent context.
        leaderProbeTask = Task { [weak self] in
            var hasObservedBrowserRecord = false
            var recordWaitRoundsLeft = Self.leaderProbeRecordWaitRounds
            while !Task.isCancelled {
                // Stop conditions checked on the main actor before each
                // round: a join URL set by another path or a browser
                // record that has gone away again both mean the loop has
                // nothing left to do (matches `clearLeaderIfNoBrowserRunning`
                // and `stopAll` semantics). A record that has *never* been
                // seen is a startup race, not a stop condition — see
                // `leaderProbeStep`.
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
                    // The caller spawns the slicc-server child right after
                    // starting this probe (reattach does so from an
                    // off-main-actor context), so the launch record can land
                    // a beat later. Wait instead of giving up.
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

                // The inner attempt window exhausted — wait a short outer backoff
                // then re-check the stop conditions and probe again.
                try? await Task.sleep(nanoseconds: UInt64(outerBackoff * 1_000_000_000))
            }
        }
    }

    /// Find the next available port pair for an Electron app.
    private func nextElectronPorts() -> (port: UInt16, cdpPort: UInt16) {
        let electronCount = UInt16(launchRecords.count)  // offset from base
        for i: UInt16 in 0...20 {
            let port = Self.electronBasePort + electronCount + i
            let cdpPort = Self.electronBaseCdpPort + electronCount + i
            if !Self.isPortInUse(port) && !Self.isPortInUse(cdpPort) {
                return (port, cdpPort)
            }
        }
        // Fallback — try anyway
        let port = Self.electronBasePort + electronCount
        return (port, Self.electronBaseCdpPort + electronCount)
    }

    // MARK: - Chrome Web Store

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

    // MARK: - Lifecycle

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

    /// Drop `leaderJoinUrl` once the last browser record has gone away,
    /// keeping the Desktop App rows accurately gated when the user closes
    /// the leader. Safe to call after any path that removes a record.
    private func clearLeaderIfNoBrowserRunning() {
        let hasBrowser = launchRecords.values.contains { $0.targetType == .chromiumBrowser && !$0.isFollower }
        if !hasBrowser {
            leaderJoinUrl = nil
        }
    }

    // MARK: - Detach / reattach (smooth-upgrade path)

    /// Snapshot every live launch record to disk and shut every slicc-server
    /// child down in *detach* mode (SIGUSR1) so the browsers/Electron apps
    /// keep running. Called immediately before AppUpdater swaps the .app
    /// bundle and relaunches Sliccstart.
    @discardableResult
    /// Test-only seam — inserts a synthetic `LaunchRecord` into the
    /// in-memory map so `detachAll()` has something to snapshot in unit
    /// tests. Underscored to make the intent obvious at call sites.
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
        // Idempotency latch — `applicationWillTerminate` re-invokes this
        // after `onBeginUpdate` already did, and the second pass would
        // otherwise overwrite the persisted JSON with an empty array
        // (because the first pass cleared `launchRecords`).
        if hasDetached {
            log.info("detachAll: already detached; returning persisted snapshot")
            return recordStore.load()
        }
        hasDetached = true
        let snapshot = launchRecords.compactMap { id, record -> PersistedLaunchRecord? in
            guard record.process.isRunning else { return nil }
            // Follower browsers survive the detach signal but are not
            // reattached: `reattachArgs` re-leads a chromiumBrowser, which
            // would wrongly re-spawn a follower as its own leader.
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
            // A lost snapshot means the surviving browsers cannot be reattached
            // after the update relaunch, so this must be visible fleet-wide.
            LauncherErrorReport.report(.updateDetach, error)
        }

        log.info("detachAll: detaching \(self.launchRecords.count) processes")
        for id in Array(launchRecords.keys) {
            detachLaunchRecord(id: id)
        }
        startFailures.removeAll()
        return snapshot
    }

    /// Re-spawn slicc-server children for every persisted record whose CDP
    /// port still answers. Records whose browser died during the update are
    /// dropped silently. Returns the targetIds that were reattached so the
    /// caller can decide what to refresh in the UI.
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

    /// Args handed to slicc-server when reattaching to a surviving runtime
    /// across a smooth update. Mirrors `electronAppArgs` /
    /// `standaloneBrowserArgs` — extracted into a pure builder so unit tests
    /// can pin the flag set (including `--join=`) without spawning a real
    /// process. The `--join=<url>` flag is gated identically to
    /// `electronAppArgs`: appended only for Electron followers with a
    /// non-nil, non-empty `joinUrl`.
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
        // The reattached server still answers /api/runtime-config, so the
        // mount table must ride along or reloads stop auto-restoring.
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
        // Re-spawn slicc-server in --serve-only mode so it reuses the
        // existing browser/Electron without re-launching it. Same ports
        // as before so the UI's bookmarked URL still works.
        guard !Self.isPortInUse(record.servePort) else {
            throw LaunchError.portInUse(record.servePort)
        }
        let extraArgs = Self.reattachArgs(
            targetType: target.type,
            electronAppPath: target.type == .electronApp ? target.path : nil,
            cdpPort: record.cdpPort,
            joinUrl: record.joinUrl,
            mounts: MountTablePreference.mappings(defaults: .standard)
        )
        // Prefer the token the runtime was ORIGINALLY launched with
        // (persisted in the record); the surviving browser tab still
        // carries it in its launch URL. Fall back to the freshly-minted
        // static token only for legacy records written before the token
        // was persisted.
        let fallbackToken =
            target.type == .chromiumBrowser
            ? Self.standaloneBridgeToken
            : Self.thinElectronBridgeToken
        let resolvedBridgeToken = record.bridgeToken ?? fallbackToken
        var env: [String: String] = ["PORT": "\(record.servePort)"]
        if target.type == .chromiumBrowser {
            env["CHROME_PATH"] = target.executablePath
            // Re-forward the persisted launcher-scoped standalone token so
            // the re-spawned `--serve-only` slicc-server resolves the same
            // bridge token, mounts thin-bridge CORS, and keeps gating
            // `/cdp` for the still-running browser after the binary swap.
            env["SLICC_BRIDGE_TOKEN"] = resolvedBridgeToken
        }
        if target.type == .electronApp {
            // Re-arm the thin-Electron env on reattach so the surviving
            // browser's overlay still talks to the gated `/cdp` after the
            // smooth-update binary swap. Same token the child was originally
            // launched with (persisted in the record).
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
            // Re-persist the resolved token so a subsequent update reattaches
            // with the same secret instead of dropping back to nil.
            bridgeToken: resolvedBridgeToken
        )
        // Re-probe the leader after reattach so the Desktop App rows come
        // back enabled across smooth-update relaunches. The already-running
        // browser still has its tray; the new slicc-server just needs to
        // refresh the join URL into the launcher. Must run *after* `spawn`
        // has registered the launch record — the probe loop's own grace
        // window covers the remaining main-actor hop, but starting it first
        // needlessly races it.
        if target.type == .chromiumBrowser {
            startLeaderProbe(servePort: record.servePort)
        }
    }

    // MARK: - Private

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
        let launchConfig = try Self.resolveLaunchConfiguration(sliccDir: sliccDir, extraArgs: extraArgs)
        let loggedArguments = Self.redactedSpawnArguments(launchConfig.arguments).joined(separator: " ")
        log.info("spawn: \(launchConfig.executablePath, privacy: .public) \(loggedArguments, privacy: .public)")
        log.info("spawn: cwd = \(self.sliccDir, privacy: .public)")

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchConfig.executablePath)
        proc.arguments = launchConfig.arguments
        proc.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)

        // Capture stdout/stderr and forward to os.log
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
            // Clean up pipe handlers
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
        try proc.run()
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

        // Standalone browsers have no Electron app to track — validate the
        // browser itself via its CDP port. Once Chrome quits the CDP port
        // (9222) frees, but the slicc-server helper keeps running, so the
        // record would otherwise linger and block relaunch. Reap the stale
        // helper only once CDP was actually seen listening (browser finished
        // booting) and has since gone away — a still-booting browser whose
        // CDP port has not come up yet (slow Keychain prompt, cold start) is
        // never prematurely reaped.
        if record.targetType == .chromiumBrowser {
            if Self.isPortInUse(record.cdpPort) {
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

        // Once the app PID is known, a `kill(pid, 0)` probe is enough; only
        // fall back to the `NSWorkspace` scan when the PID is gone or unknown.
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
                !Self.isPortInUse(record.cdpPort)
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
            !Self.isPortInUse(record.cdpPort)
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

    /// Detach a single record: SIGUSR1 to slicc-server (graceful shutdown
    /// that skips Browser.close) and explicitly do NOT terminate the
    /// Electron app. The slicc-server child has up to a few seconds to
    /// exit; if it ignores SIGUSR1 we fall back to SIGTERM to avoid
    /// leaking processes across the update.
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
            // Best-effort wait for the detach path to land before AppUpdater
            // swaps the .app from under us. 1.5s mirrors the
            // browserExitTimeoutNanoseconds budget on the server side.
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
        // Fast path: a launch record that already observed the app's PID only
        // needs a `kill(pid, 0)` probe. The full `NSWorkspace` scan below is
        // called from every SwiftUI render *and* the 2s refresh timer, so it
        // must stay off the hot path once the app is known.
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

    /// Expands each launcher-side app path into the set of spellings a running
    /// app's `bundleURL` may report (as given, tilde-expanded, standardized,
    /// symlink-resolved). Symlink resolution touches the filesystem, so it is
    /// done once per *candidate* here rather than once per *running app* in
    /// the scan — the latter cost ~35% CPU on the main thread with a few
    /// hundred apps running (lstat per path component, every 2s and every
    /// SwiftUI render).
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

    /// Pure string comparison — no filesystem access. `bundlePath` matches
    /// exactly; `executablePath` matches when it lives under a candidate's
    /// `Contents/MacOS/`.
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

    private static func isPortInUse(_ port: UInt16) -> Bool {
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
