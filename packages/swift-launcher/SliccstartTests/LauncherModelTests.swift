import AppKit
import SliccTrayFollower
import SliccTraySession
import SliccWidgetKit
import XCTest

@testable import Sliccstart

/// The launcher window's behavior, which used to be unreachable: it lived in
/// closures inside `SliccstartApp`'s `WindowGroup`, and an `App`'s `Scene`
/// cannot be rendered or driven from a test. `LauncherModel` is that code,
/// extracted; these exercise the decisions it makes.
@MainActor
final class LauncherModelTests: XCTestCase {

    // MARK: - Fixtures

    private var container: URL!
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        container = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("launcher-model-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        suiteName = "sliccstart.tests.model.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: container)
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
    }

    private func target(
        _ name: String,
        type: AppTargetType = .chromiumBrowser,
        debugSupport: ElectronDebugSupport = .unknown,
        bundleId: String? = nil
    ) -> AppTarget {
        AppTarget(
            id: "/Applications/\(name).app",
            name: name,
            path: "/Applications/\(name).app",
            executablePath: "/Applications/\(name).app/Contents/MacOS/\(name)",
            type: type,
            icon: NSImage(),
            debugSupport: debugSupport,
            isDebugBuild: false,
            originalAppPath: nil,
            bundleId: bundleId ?? "com.test.\(name.lowercased())"
        )
    }

    private struct Recorder {
        var scans: [Bool] = []
        var debugBuilds: [String] = []
        var checks = 0
    }

    /// A model wired entirely to stubs: nothing here scans /Applications,
    /// patches an `.app`, or reaches GitHub.
    private func makeModel(
        process: SliccProcess = SliccProcess(),
        scan: @escaping (Bool) -> [AppTarget] = { _ in [] },
        installation: InstallationStatus = .installed,
        makeDebugBuild: @escaping (String, @escaping (String) -> Void) async throws -> String = {
            path, _ in path
        },
        isBundledBuild: Bool = false,
        startupLaunchEnabled: Bool = false,
        savedBrowserOrder: [String] = [],
        updateChecking: LauncherModel.UpdateChecking? = nil,
        bootstrapper: SliccBootstrapper = SliccBootstrapper()
    ) -> LauncherModel {
        LauncherModel(
            process: process,
            sessionStore: TraySessionSyncStore(
                backend: InMemoryKeyValueBackend(),
                deviceId: "this-device",
                deviceName: "This Mac"
            ),
            fileProviderCoordinator: FileProviderCoordinator(defaults: defaults),
            widgetTrayObserver: WidgetTrayObserver(
                publisher: WidgetSnapshotPublisher(
                    store: WidgetSnapshotStore(appGroup: "test") { [container] _ in container! },
                    minimumInterval: 0
                ),
                installation: WidgetInstallationQuery { false },
                makeConnector: { _ in NeverConnector() }
            ),
            bootstrapper: bootstrapper,
            updateChecking: updateChecking
                ?? LauncherModel.UpdateChecking(check: { _, _ in }, isUpdateReady: { false }),
            scanApps: scan,
            checkInstallation: { _ in installation },
            makeDebugBuild: makeDebugBuild,
            isBundledBuild: { isBundledBuild },
            startupLaunchEnabled: { startupLaunchEnabled },
            savedBrowserOrder: { savedBrowserOrder }
        )
    }

    // MARK: - Startup

    func testInitializeScansAndBecomesReady() async {
        let chrome = target("Chrome")
        let model = makeModel(scan: { _ in [chrome] })

        await model.initialize()

        XCTAssertTrue(model.isReady)
        XCTAssertEqual(model.targets.map(\.name), ["Chrome"])
    }

    func testAFailedBootstrapStaysOnTheSetupScreenWithTheReason() async {
        struct Boom: LocalizedError { var errorDescription: String? { "no network" } }
        let bootstrapper = FailingBootstrapper(error: Boom())
        let model = makeModel(installation: .notInstalled, bootstrapper: bootstrapper)

        await model.initialize()

        XCTAssertFalse(model.isReady, "a launcher with no runtime must not show the app list")
        XCTAssertEqual(model.bootstrapper.lastError, "no network")
        XCTAssertEqual(model.bootstrapper.progressMessage, "no network")
    }

    func testAnInstalledRuntimeSkipsTheBootstrapEntirely() async {
        let bootstrapper = FailingBootstrapper(error: CancellationError())
        let model = makeModel(installation: .installed, bootstrapper: bootstrapper)

        await model.initialize()

        XCTAssertEqual(bootstrapper.bootstrapCalls, 0)
        XCTAssertTrue(model.isReady)
    }

    func testNeedsBuildIsNotTreatedAsMissing() async {
        // `needsBuild` means the checkout is there but unbuilt — bootstrapping
        // again would re-clone over the user's tree.
        let bootstrapper = FailingBootstrapper(error: CancellationError())
        let model = makeModel(installation: .needsBuild, bootstrapper: bootstrapper)

        await model.initialize()

        XCTAssertEqual(bootstrapper.bootstrapCalls, 0)
        XCTAssertTrue(model.isReady)
    }

    func testAnUnbundledBuildNeverChecksForUpdatesAtStartup() async {
        var checks = 0
        let model = makeModel(
            isBundledBuild: false,
            updateChecking: .init(check: { _, _ in checks += 1 }, isUpdateReady: { false })
        )

        await model.initialize()

        XCTAssertEqual(checks, 0, "a source build has no .app for the updater to replace")
        XCTAssertEqual(model.updateCheckStatus, .idle)
    }

    func testABundledBuildChecksForUpdatesAtStartup() async {
        var checks = 0
        let model = makeModel(
            isBundledBuild: true,
            updateChecking: .init(check: { _, _ in checks += 1 }, isUpdateReady: { false })
        )

        await model.initialize()

        XCTAssertEqual(checks, 1)
    }

    // MARK: - Auto-launch

    func testAutoLaunchIsSkippedWhenThePreferenceIsOff() async {
        let process = RecordingProcess()
        let model = makeModel(
            process: process,
            scan: { _ in [self.target("Chrome", bundleId: "com.google.Chrome")] },
            startupLaunchEnabled: false
        )

        await model.initialize()

        XCTAssertTrue(process.standaloneLaunches.isEmpty)
    }

    func testAutoLaunchStartsTheTopBrowser() async {
        let process = RecordingProcess()
        let model = makeModel(
            process: process,
            scan: { _ in
                [
                    self.target("Chrome", bundleId: "com.google.Chrome"),
                    self.target("Brave", bundleId: "com.brave.Browser"),
                ]
            },
            startupLaunchEnabled: true,
            savedBrowserOrder: ["com.brave.Browser", "com.google.Chrome"]
        )

        await model.initialize()

        XCTAssertEqual(
            process.standaloneLaunches,
            ["Brave"],
            "auto-launch must follow the user's drag order, not the scan order"
        )
    }

    func testAutoLaunchWithNoBrowsersInstalledIsQuiet() async {
        let process = RecordingProcess()
        let model = makeModel(
            process: process,
            scan: { _ in [self.target("Terminal", type: .terminal)] },
            startupLaunchEnabled: true
        )

        await model.initialize()

        XCTAssertTrue(process.standaloneLaunches.isEmpty)
        XCTAssertTrue(model.isReady, "no browser to auto-launch is not a startup failure")
    }

    func testAFailedAutoLaunchDoesNotBlockStartupOrAlert() async {
        let process = RecordingProcess()
        process.standaloneError = SliccProcess.LaunchError.serverBinaryNotFound
        let model = makeModel(
            process: process,
            scan: { _ in [self.target("Chrome", bundleId: "com.google.Chrome")] },
            startupLaunchEnabled: true
        )

        await model.initialize()

        XCTAssertTrue(model.isReady)
        XCTAssertFalse(
            model.showAlert,
            "a startup auto-launch failure is logged, not thrown in the user's face"
        )
    }

    // MARK: - Launching from the list

    func testLaunchFailureBecomesAnAlert() {
        let process = RecordingProcess()
        process.standaloneError = SliccProcess.LaunchError.serverBinaryNotFound
        let model = makeModel(process: process)

        model.launchStandalone(target("Chrome"))

        XCTAssertTrue(model.showAlert)
        XCTAssertEqual(model.alertMessage, SliccProcess.LaunchError.serverBinaryNotFound.errorDescription)
    }

    func testABrowserFollowerCarriesTheJoinUrl() {
        let process = RecordingProcess()
        let model = makeModel(process: process)

        model.launchBrowserFollower(target("Chrome"), joinUrl: "https://tray.test/join/x.secret")

        XCTAssertEqual(process.followerLaunches, ["Chrome|https://tray.test/join/x.secret"])
        XCTAssertFalse(model.showAlert)
    }

    func testAFailedFollowerLaunchAlerts() {
        let process = RecordingProcess()
        process.followerError = SliccProcess.LaunchError.serverBinaryNotFound
        let model = makeModel(process: process)

        model.launchBrowserFollower(target("Chrome"), joinUrl: "https://tray.test/join/x.secret")

        XCTAssertTrue(model.showAlert)
    }

    // MARK: - Electron rows

    private func electronModel(state: AppRuntimeState) -> (LauncherModel, RecordingProcess) {
        let process = RecordingProcess()
        process.stubbedRuntimeState = state
        return (makeModel(process: process), process)
    }

    func testAnAlreadyDebuggedElectronAppIsLeftAlone() {
        let (model, process) = electronModel(state: .runningWithDebug(cdpPort: 9222))
        model.handleElectronLaunch(target("Signal", type: .electronApp))
        XCTAssertTrue(process.electronLaunches.isEmpty)
        XCTAssertFalse(model.showElectronRestartDialog)
    }

    func testAnElectronAppRunningWithoutDebugAsksBeforeRestartingIt() {
        let (model, process) = electronModel(state: .runningWithoutDebug)
        let signal = target("Signal", type: .electronApp)

        model.handleElectronLaunch(signal)
        XCTAssertTrue(model.showElectronRestartDialog)
        XCTAssertEqual(model.electronRestartTarget?.name, "Signal")
        XCTAssertTrue(process.electronLaunches.isEmpty, "the app must not be killed before consent")

        model.confirmElectronRestart()
        XCTAssertEqual(process.electronLaunches, ["Signal|force"])
        XCTAssertNil(model.electronRestartTarget)
    }

    func testCancellingTheRestartDialogLeavesTheAppRunning() {
        let (model, process) = electronModel(state: .runningWithoutDebug)
        model.handleElectronLaunch(target("Signal", type: .electronApp))
        model.cancelElectronRestart()
        XCTAssertNil(model.electronRestartTarget)
        XCTAssertTrue(process.electronLaunches.isEmpty)
    }

    func testAnElectronAppNeedingADebugBuildOpensThatDialogInstead() {
        let (model, _) = electronModel(state: .cannotStart(.needsDebugBuild))
        model.handleElectronLaunch(target("Signal", type: .electronApp))
        XCTAssertTrue(model.showDebugBuildDialog)
        XCTAssertEqual(model.debugBuildTarget?.name, "Signal")
    }

    func testAnElectronAppNeedingPermissionOpensSystemSettings() {
        let (model, _) = electronModel(state: .cannotStart(.needsPermission))
        let permission = RecordingPermission()
        let scoped = LauncherModel(
            process: model.process,
            sessionStore: model.sessionStore,
            fileProviderCoordinator: model.fileProviderCoordinator,
            widgetTrayObserver: model.widgetTrayObserver,
            permission: permission,
            updateChecking: .init(check: { _, _ in }, isUpdateReady: { false })
        )

        scoped.handleElectronLaunch(target("Signal", type: .electronApp))

        XCTAssertEqual(permission.openedSettings, 1)
        XCTAssertFalse(scoped.showDebugBuildDialog)
    }

    func testAnElectronAppWithoutALeaderIsIgnoredRatherThanStarted() {
        // The row is disabled in the list, so this is only reachable
        // programmatically — and starting a follower with no leader would
        // strand it.
        let (model, process) = electronModel(state: .cannotStart(.needsLeader))
        model.handleElectronLaunch(target("Signal", type: .electronApp))
        XCTAssertTrue(process.electronLaunches.isEmpty)
        XCTAssertFalse(model.showElectronRestartDialog)
        XCTAssertFalse(model.showDebugBuildDialog)
    }

    func testAStoppedElectronAppLaunchesDirectly() {
        let (model, process) = electronModel(state: .notRunning)
        model.handleElectronLaunch(target("Signal", type: .electronApp))
        XCTAssertEqual(process.electronLaunches, ["Signal"])
    }

    func testAPreviouslyFailedElectronAppRetries() {
        let (model, process) = electronModel(state: .startFailed(message: "boom"))
        model.handleElectronLaunch(target("Signal", type: .electronApp))
        XCTAssertEqual(process.electronLaunches, ["Signal"])
    }

    func testAFailedElectronLaunchAlerts() {
        let (model, process) = electronModel(state: .notRunning)
        process.electronError = SliccProcess.LaunchError.serverBinaryNotFound
        model.handleElectronLaunch(target("Signal", type: .electronApp))
        XCTAssertTrue(model.showAlert)
    }

    // MARK: - Debug builds

    func testCreatingADebugBuildRescansAndReportsSuccess() async {
        var scans = 0
        let model = makeModel(
            scan: { _ in
                scans += 1
                return []
            },
            makeDebugBuild: { path, progress in
                progress("Patching fuses")
                return path
            }
        )

        model.requestDebugBuild(for: target("Signal", type: .electronApp))
        XCTAssertTrue(model.showDebugBuildDialog)

        await model.confirmDebugBuild()

        XCTAssertGreaterThan(scans, 0, "the new debug build has to be picked up by a rescan")
        XCTAssertTrue(model.showAlert)
        XCTAssertEqual(model.alertMessage?.hasPrefix("Debug build created!"), true)
        XCTAssertFalse(model.isCreatingDebugBuild)
        XCTAssertNil(model.debugBuildTarget)
    }

    func testAFailedDebugBuildReportsAndStopsTheProgressScreen() async {
        struct Boom: LocalizedError { var errorDescription: String? { "asar is signed" } }
        let model = makeModel(makeDebugBuild: { _, _ in throw Boom() })

        await model.createDebugBuild(for: target("Signal", type: .electronApp))

        XCTAssertTrue(model.showAlert)
        XCTAssertEqual(model.alertMessage?.contains("asar is signed"), true)
        XCTAssertFalse(
            model.isCreatingDebugBuild,
            "a failed build must not strand the window on the progress screen"
        )
    }

    func testCancellingTheDebugBuildDialogBuildsNothing() async {
        var built: [String] = []
        let model = makeModel(makeDebugBuild: { path, _ in
            built.append(path)
            return path
        })

        model.requestDebugBuild(for: target("Signal", type: .electronApp))
        model.cancelDebugBuild()
        await model.confirmDebugBuild()

        XCTAssertTrue(built.isEmpty)
    }

    // MARK: - Updates

    func testACheckInFlightIsNotRestarted() {
        var checks = 0
        let model = makeModel(
            updateChecking: .init(check: { _, _ in checks += 1 }, isUpdateReady: { false })
        )

        model.checkForUpdates()
        model.checkForUpdates()

        XCTAssertEqual(checks, 1)
        XCTAssertEqual(model.updateCheckStatus, .checking)
    }

    func testASuccessfulCheckWithNothingNewerSaysUpToDate() async {
        let model = makeModel(
            updateChecking: .init(check: { success, _ in success() }, isUpdateReady: { false })
        )

        model.checkForUpdates()
        await settle()

        XCTAssertEqual(model.updateCheckStatus, .upToDate)
    }

    func testASuccessfulCheckWithAStagedUpdateGoesBackToIdle() async {
        // `.idle` is what lets the footer offer the download/restart flow.
        let model = makeModel(
            updateChecking: .init(check: { success, _ in success() }, isUpdateReady: { true })
        )

        model.checkForUpdates()
        await settle()

        XCTAssertEqual(model.updateCheckStatus, .idle)
    }

    func testAFailedCheckIsClassifiedRatherThanDropped() async {
        let translocated = NSError(
            domain: NSCocoaErrorDomain,
            code: NSFileWriteVolumeReadOnlyError
        )
        let model = makeModel(
            updateChecking: .init(check: { _, fail in fail(translocated) }, isUpdateReady: { false })
        )

        model.checkForUpdates()
        await settle()

        XCTAssertEqual(
            model.updateCheckStatus,
            .translocated,
            "a read-only volume is a move-to-Applications problem, not a network failure"
        )
        XCTAssertTrue(model.updateCheckStatus.allowsRetry)
    }

    func testBeginningAnAppUpdateDetachesInsteadOfKilling() {
        let process = RecordingProcess()
        let model = makeModel(process: process)

        model.beginAppUpdate()

        XCTAssertTrue(
            process.isPreparingForUpdate,
            "without this flag applicationWillTerminate would stop every browser"
        )
        XCTAssertEqual(process.detachCalls, 1)
    }

    func testUpdatingTheRuntimeReturnsToTheListEvenWhenItFails() async {
        struct Boom: LocalizedError { var errorDescription: String? { "npm exploded" } }
        let bootstrapper = FailingBootstrapper(error: Boom())
        let model = makeModel(bootstrapper: bootstrapper)
        model.isReady = true

        await model.updateRuntime()

        XCTAssertTrue(model.isReady, "a failed runtime update must not strand the setup screen")
        XCTAssertEqual(model.bootstrapper.lastError, "npm exploded")
    }

    // MARK: - Periodic work

    func testTheRuntimeTickDoesNothingBeforeTheWindowIsReady() {
        let process = RecordingProcess()
        let model = makeModel(process: process)

        model.runtimeTick(isUpdateDownloaded: false)

        XCTAssertEqual(process.refreshCalls, 0)
    }

    func testTheRuntimeTickOnlyAsksAboutAgentActivityWithAnUpdateStaged() async {
        let process = RecordingProcess()
        let model = makeModel(process: process)
        model.isReady = true

        model.runtimeTick(isUpdateDownloaded: false)
        XCTAssertEqual(process.refreshCalls, 1)
        XCTAssertEqual(process.agentActivityCalls, 0, "polling /api/agent-activity for nothing")
        XCTAssertFalse(model.hasRecentAgentActivity)

        process.agentActivity = true
        model.runtimeTick(isUpdateDownloaded: true)
        await settle()
        XCTAssertEqual(process.agentActivityCalls, 1)
        XCTAssertTrue(model.hasRecentAgentActivity)
    }

    func testActivatingTheAppRefreshesOnlyWhenReady() {
        let process = RecordingProcess()
        let model = makeModel(process: process)

        model.refreshRuntimeStatesOnActivate()
        XCTAssertEqual(process.refreshCalls, 0)

        model.isReady = true
        model.refreshRuntimeStatesOnActivate()
        XCTAssertEqual(process.refreshCalls, 1)
    }

    func testGrantingPermissionRescansOnlyOnceTheWindowIsUp() {
        var scans = 0
        let model = makeModel(scan: { _ in
            scans += 1
            return []
        })

        model.appManagementPermissionChanged()
        XCTAssertEqual(scans, 0)

        model.isReady = true
        model.appManagementPermissionChanged()
        XCTAssertEqual(scans, 1)
    }

    // MARK: - Leader identity

    func testALeaderIsAdvertisedToEveryConsumerOfTheJoinUrl() {
        let model = makeModel()
        model.leaderJoinUrlChanged("https://tray.test/join/x.secret")

        XCTAssertEqual(model.sessionStore.localSessions.count, 1)
        XCTAssertEqual(
            model.sessionStore.localSessions.first?.joinUrl,
            "https://tray.test/join/x.secret"
        )
    }

    func testLosingTheLeaderWithdrawsTheAdvertisement() {
        let model = makeModel()
        model.leaderJoinUrlChanged("https://tray.test/join/x.secret")
        XCTAssertEqual(model.sessionStore.localSessions.count, 1)

        model.leaderJoinUrlChanged(nil)
        XCTAssertTrue(
            model.sessionStore.localSessions.isEmpty,
            "a dead leader must stop being advertised to the user's other devices"
        )
    }

    func testAnEmptyJoinUrlCountsAsNoLeader() {
        let model = makeModel()
        model.leaderJoinUrlChanged("")
        XCTAssertTrue(model.sessionStore.localSessions.isEmpty)
    }

    func testRepublishingRefreshesALiveLeaderAndSkipsADeadOne() async throws {
        let model = makeModel(process: SliccProcess())
        model.isReady = true

        model.republishLeaderSession()
        await settle()
        XCTAssertTrue(model.sessionStore.localSessions.isEmpty, "nothing to refresh without a leader")

        let live = makeModel(process: try leaderProcess(answering: .joinUrl("https://tray.test/join/x.secret")))
        live.isReady = true
        live.republishLeaderSession()
        await waitUntil { live.sessionStore.localSessions.count == 1 }
        XCTAssertEqual(live.sessionStore.localSessions.count, 1)
    }

    /// The republish beat used to stamp `lastSeenAt` onto whatever URL was
    /// cached at launch. On a Mac whose lid is shut that is a fiction the
    /// beat keeps renewing — a `Timer` fires on any run-loop tick it gets,
    /// including a dark wake — so the session never aged out and the user's
    /// other devices kept offering a leader nobody could reach.
    func testRepublishingDoesNotRenewALeaderThatCannotBeReached() async throws {
        let probes = ProbeCounter()
        let process = try leaderProcess(answering: .unreachable, counting: probes)
        process.leaderJoinUrl = "https://tray.test/join/cached.secret"
        let model = makeModel(process: process)
        model.isReady = true
        model.leaderJoinUrlChanged("https://tray.test/join/cached.secret")
        let published = model.sessionStore.localSessions.first?.lastSeenAt

        model.republishLeaderSession()
        // The unreachable answer is retried, so the beat only finishes once
        // every attempt has been spent — waiting on the probe count (not on a
        // yield budget) is what makes this assertion observe the outcome.
        await waitUntilProbed(probes, atLeast: republishProbeAttempts)
        await settle()

        let probeCount = await probes.count
        XCTAssertEqual(
            probeCount,
            republishProbeAttempts,
            "the beat must verify the leader before it advertises it")
        XCTAssertEqual(
            model.sessionStore.localSessions.first?.lastSeenAt,
            published,
            "an unverifiable session must be left to age out of the store's TTL")
    }

    func testRepublishingAdvertisesTheUrlTheLeaderServesNow() async throws {
        let process = try leaderProcess(answering: .joinUrl("https://tray.test/join/reminted.secret"))
        process.leaderJoinUrl = "https://tray.test/join/stale.secret"
        let model = makeModel(process: process)
        model.isReady = true

        model.republishLeaderSession()
        await waitUntil { !model.sessionStore.localSessions.isEmpty }

        XCTAssertEqual(
            model.sessionStore.localSessions.map(\.joinUrl),
            ["https://tray.test/join/reminted.secret"])
    }

    /// Sessions are keyed by `SHA256(joinUrl)`, so a re-minted tray adds a
    /// row rather than replacing one: the predecessor has to be withdrawn or
    /// the device advertises two sessions, one of them dead, for 12h.
    func testAReMintedTrayReplacesTheAdvertisementItSupersedes() {
        let model = makeModel()
        model.leaderJoinUrlChanged("https://tray.test/join/old.secret")

        model.leaderJoinUrlChanged(
            "https://tray.test/join/new.secret", previous: "https://tray.test/join/old.secret")

        XCTAssertEqual(
            model.sessionStore.localSessions.map(\.joinUrl), ["https://tray.test/join/new.secret"])
    }

    func testRepublishingIsSkippedBeforeTheWindowIsReady() async throws {
        let probes = ProbeCounter()
        let model = makeModel(
            process: try leaderProcess(
                answering: .joinUrl("https://tray.test/join/x.secret"), counting: probes))

        model.republishLeaderSession()
        await settle()

        let probeCount = await probes.count
        XCTAssertTrue(model.sessionStore.localSessions.isEmpty)
        XCTAssertEqual(probeCount, 0, "no window, no probe")
    }

    // MARK: - Republish fixtures

    private enum TrayStatusAnswer {
        case joinUrl(String)
        case unreachable
    }

    private actor ProbeCounter {
        private(set) var count = 0
        func tick() { count += 1 }
    }

    /// A `SliccProcess` with a live leader launch record whose
    /// `/api/tray-status` answers as instructed, so `republishLeaderSession`
    /// runs the real refresh instead of a stub.
    private func leaderProcess(
        answering answer: TrayStatusAnswer,
        counting probes: ProbeCounter? = nil
    ) throws -> SliccProcess {
        let process = SliccProcess(
            trayStatusProbe: TrayStatusProbe(fetch: { _ in
                await probes?.tick()
                switch answer {
                case .joinUrl(let url):
                    return (200, Data(#"{"state":"connected","joinUrl":"\#(url)"}"#.utf8))
                case .unreachable:
                    return (503, Data())
                }
            }))
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sleep")
        helper.arguments = ["60"]
        try helper.run()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }
        process._testing_seedLaunchRecord(
            id: "browser-1",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "TestBrowser"
        )
        return process
    }

    /// Attempts `republishLeaderSession` gives the leader to answer.
    private let republishProbeAttempts = 3

    private func waitUntilProbed(
        _ probes: ProbeCounter,
        atLeast count: Int,
        timeout: TimeInterval = 10.0
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while await probes.count < count && Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func waitUntil(
        _ condition: () -> Bool,
        timeout: TimeInterval = 3.0
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    // MARK: - Alert prompts

    func testDialogPromptsNameTheAppTheyAreAbout() {
        let signal = target("Signal", type: .electronApp)
        XCTAssertTrue(RootView.debugBuildPrompt(for: signal).contains("Signal Debug.app"))
        XCTAssertTrue(RootView.electronRestartPrompt(for: signal).contains("Signal is already running"))
    }

    /// Let work a call hopped into a `Task` land before asserting on it.
    /// Generous on purpose: CI is slow enough that a tight yield count has
    /// been the difference between a real assertion and a coin flip.
    private func settle() async {
        for _ in 0..<50 { await Task.yield() }
    }
}

// MARK: - Stubs

/// Records what the model asked the process to do instead of launching
/// browsers, patching apps, or probing ports.
private final class RecordingProcess: SliccProcess {
    var standaloneLaunches: [String] = []
    var followerLaunches: [String] = []
    var electronLaunches: [String] = []
    var refreshCalls = 0
    var detachCalls = 0
    var agentActivityCalls = 0
    var agentActivity = false
    var standaloneError: Error?
    var followerError: Error?
    var electronError: Error?
    var stubbedRuntimeState: AppRuntimeState?

    override func launchStandalone(_ target: AppTarget) throws {
        if let standaloneError { throw standaloneError }
        standaloneLaunches.append(target.name)
    }

    override func launchBrowserFollower(_ target: AppTarget, joinUrl: String) throws {
        if let followerError { throw followerError }
        followerLaunches.append("\(target.name)|\(joinUrl)")
    }

    override func launchWithElectronApp(
        _ target: AppTarget,
        forceRestartExistingApp: Bool = false
    ) throws {
        if let electronError { throw electronError }
        electronLaunches.append(forceRestartExistingApp ? "\(target.name)|force" : target.name)
    }

    override func runtimeState(
        for target: AppTarget,
        hasAppManagementPermission: Bool = true
    ) -> AppRuntimeState {
        stubbedRuntimeState
            ?? super.runtimeState(for: target, hasAppManagementPermission: hasAppManagementPermission)
    }

    override func refreshRuntimeStates(for targets: [AppTarget]) {
        refreshCalls += 1
    }

    @discardableResult
    override func detachAll() -> [PersistedLaunchRecord] {
        detachCalls += 1
        return []
    }

    override func hasRecentAgentActivity() async -> Bool {
        agentActivityCalls += 1
        return agentActivity
    }

    @discardableResult
    override func reattachPersistedRecords(targets: [AppTarget]) async -> [String] {
        []
    }
}

/// A bootstrapper whose every operation fails, so the model's error handling
/// is exercised without running npm.
private final class FailingBootstrapper: SliccBootstrapper {
    private let error: Error
    private(set) var bootstrapCalls = 0

    init(error: Error) {
        self.error = error
        super.init()
    }

    override func bootstrap(sliccDir: String = SliccBootstrapper.defaultSliccDir) async throws {
        bootstrapCalls += 1
        throw error
    }

    override func update(sliccDir: String = SliccBootstrapper.defaultSliccDir) async throws {
        throw error
    }
}

private final class RecordingPermission: AppManagementPermission {
    private(set) var openedSettings = 0

    override func openSystemSettings() {
        openedSettings += 1
    }
}

@MainActor
private final class NeverConnector: WidgetTrayConnecting {
    weak var delegate: TrayFollowerConnectorDelegate?
    func start() async throws {}
    func stop() {}
}
