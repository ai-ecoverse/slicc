import AppKit
import XCTest

@testable import Sliccstart

/// The launch paths — `launchStandalone`, `launchBrowserFollower`,
/// `launchWithElectronApp` and the `spawn` they share. Previously untested at
/// all, because reaching them meant starting a real browser and binding the
/// real ports.
///
/// `SliccProcess.SpawnServices` substitutes exactly three things: which binary
/// to run, whether to exec it, and whether a port is bound. Everything else is
/// the shipping code — the real argument vector, a real `Process` (running
/// `/bin/sleep`), the real launch record, the real termination handler — so
/// these exercise the launch bookkeeping rather than a mock of it.
@MainActor
final class SliccProcessLaunchPathTests: XCTestCase {

    /// Records every spawn and runs a harmless stand-in child, so records,
    /// pids and termination handling stay real.
    private final class SpawnRecorder {
        struct Spawned {
            let executablePath: String
            let arguments: [String]
            let environment: [String: String]
            let currentDirectory: String?
        }

        private(set) var spawns: [Spawned] = []
        private(set) var resolveCalls: [[String]] = []
        var portsInUse: Set<UInt16> = []
        var resolveError: Error?
        var runError: Error?
        /// Keep the stand-in children so a test can end them deterministically.
        private(set) var children: [Process] = []

        func services() -> SliccProcess.SpawnServices {
            SliccProcess.SpawnServices(
                resolveLaunchConfiguration: { [unowned self] _, extraArgs in
                    resolveCalls.append(extraArgs)
                    if let resolveError { throw resolveError }
                    return SliccProcess.LaunchConfiguration(
                        executablePath: "/usr/bin/slicc-server-stand-in",
                        arguments: extraArgs,
                        logLabel: "test"
                    )
                },
                runProcess: { [unowned self] process in
                    spawns.append(
                        Spawned(
                            executablePath: process.executableURL?.path ?? "",
                            arguments: process.arguments ?? [],
                            environment: process.environment ?? [:],
                            currentDirectory: process.currentDirectoryURL?.path
                        )
                    )
                    if let runError { throw runError }
                    // Run something harmless in its place so the record holds a
                    // live process, exactly as it would in production. The
                    // stand-in also needs a working directory that exists: the
                    // real one is the resolved slicc dir, which on a machine
                    // with no checkout (CI, a fresh Mac) is a `~/.slicc/slicc`
                    // that has not been bootstrapped yet — `Process.run()`
                    // then fails with "The file 'slicc' doesn't exist" and the
                    // test is testing the runner's disk, not the launcher.
                    // What production would have used is captured above.
                    process.executableURL = URL(fileURLWithPath: "/bin/sleep")
                    process.arguments = ["45"]
                    process.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory())
                    try process.run()
                    children.append(process)
                },
                isPortInUse: { [unowned self] port in portsInUse.contains(port) }
            )
        }

        func terminateChildren() {
            for child in children where child.isRunning { child.terminate() }
        }
    }

    private var recorder: SpawnRecorder!

    override func setUp() {
        super.setUp()
        recorder = SpawnRecorder()
    }

    override func tearDown() {
        recorder.terminateChildren()
        super.tearDown()
    }

    private func makeProcess(
        records: LaunchRecordStore? = nil
    ) -> SliccProcess {
        SliccProcess(
            recordStore: records
                ?? LaunchRecordStore(
                    storeURL: URL(fileURLWithPath: NSTemporaryDirectory())
                        .appendingPathComponent("launch-records-\(UUID().uuidString).json")
                ),
            // A probe that never answers keeps the leader-probe loop from
            // reaching the network; the probe itself has its own tests.
            trayStatusProbe: TrayStatusProbe { _ in
                throw URLError(.cannotConnectToHost)
            },
            spawnServices: recorder.services()
        )
    }

    private func target(
        _ name: String,
        type: AppTargetType = .chromiumBrowser,
        debugSupport: ElectronDebugSupport = .supported
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
            bundleId: "com.test.\(name.lowercased())"
        )
    }

    // MARK: - Standalone browser (the leader)

    func testLaunchingABrowserSpawnsAServerAndRecordsItAsTheLeader() throws {
        let process = makeProcess()
        let chrome = target("Chrome")

        try process.launchStandalone(chrome)

        XCTAssertEqual(recorder.spawns.count, 1)
        let args = try XCTUnwrap(recorder.spawns.first).arguments
        XCTAssertTrue(args.contains("--lead"), "a standalone browser leads its own session: \(args)")
        XCTAssertTrue(
            args.contains { $0.hasPrefix("--cdp-port=") },
            "the server needs the browser's CDP port: \(args)"
        )
        XCTAssertTrue(process.isRunning(chrome))
        XCTAssertEqual(process.runtimeState(for: chrome), .runningWithDebug(cdpPort: 9222))
        XCTAssertEqual(process.leaderTargetName, "Chrome")
    }

    func testTheSpawnedServerInheritsTheEnvironmentItNeeds() throws {
        let process = makeProcess()
        try process.launchStandalone(target("Chrome"))

        let spawned = try XCTUnwrap(recorder.spawns.first)
        XCTAssertEqual(
            spawned.environment["CHROME_PATH"],
            "/Applications/Chrome.app/Contents/MacOS/Chrome",
            "the server launches the browser, so it has to know which one"
        )
        XCTAssertEqual(spawned.environment["PORT"], "5710")
        XCTAssertFalse(
            spawned.environment["SLICC_BRIDGE_TOKEN"]?.isEmpty ?? true,
            "the bridge token gates /cdp from first launch and has to survive a reattach"
        )
        XCTAssertEqual(
            spawned.currentDirectory,
            process.resolvedSliccDir,
            "the child runs from the resolved slicc dir"
        )
    }

    func testLaunchingABrowserThatIsAlreadyRunningIsANoOp() throws {
        let process = makeProcess()
        let chrome = target("Chrome")

        try process.launchStandalone(chrome)
        try process.launchStandalone(chrome)

        XCTAssertEqual(
            recorder.spawns.count,
            1,
            "a second click must not start a second server for the same browser"
        )
    }

    func testABusyPortIsReportedRatherThanFoughtOver() {
        let process = makeProcess()
        recorder.portsInUse = [5710]

        XCTAssertThrowsError(try process.launchStandalone(target("Chrome"))) { error in
            guard case SliccProcess.LaunchError.portInUse(let port) = error else {
                return XCTFail("expected portInUse, got \(error)")
            }
            XCTAssertEqual(port, 5710)
        }
        XCTAssertTrue(recorder.spawns.isEmpty)
    }

    func testAFailureToResolveTheServerIsRecordedOnTheRow() {
        let process = makeProcess()
        recorder.resolveError = SliccProcess.LaunchError.serverBinaryNotFound
        let chrome = target("Chrome")

        XCTAssertThrowsError(try process.launchStandalone(chrome))

        XCTAssertEqual(
            process.runtimeState(for: chrome),
            .startFailed(message: SliccProcess.LaunchError.serverBinaryNotFound.errorDescription ?? ""),
            "a failed start has to show on the row, not just throw"
        )
    }

    func testAFailedStartIsClearedByTheNextAttempt() throws {
        let process = makeProcess()
        let chrome = target("Chrome")
        recorder.resolveError = SliccProcess.LaunchError.serverBinaryNotFound
        XCTAssertThrowsError(try process.launchStandalone(chrome))
        guard case .startFailed = process.runtimeState(for: chrome) else {
            return XCTFail("expected a recorded failure")
        }

        recorder.resolveError = nil
        try process.launchStandalone(chrome)

        XCTAssertEqual(process.runtimeState(for: chrome), .runningWithDebug(cdpPort: 9222))
    }

    func testTheMountTableReachesTheBrowserArguments() throws {
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: MountTablePreference.key)
        defaults.set("/Users/test/code:/mnt/code", forKey: MountTablePreference.key)
        defer {
            if let previous {
                defaults.set(previous, forKey: MountTablePreference.key)
            } else {
                defaults.removeObject(forKey: MountTablePreference.key)
            }
        }

        let process = makeProcess()
        try process.launchStandalone(target("Chrome"))

        let args = try XCTUnwrap(recorder.spawns.first).arguments
        XCTAssertTrue(
            args.contains("--mount=/Users/test/code:/mnt/code"),
            "a configured mount must be passed to the server: \(args)"
        )
    }

    // MARK: - Browser follower (attach to a remote tray)

    func testAFollowerCarriesTheJoinUrlAndNeverBecomesTheLeader() throws {
        let process = makeProcess()
        let chrome = target("Chrome")

        try process.launchBrowserFollower(chrome, joinUrl: "https://tray.test/join/x.secret")

        let args = try XCTUnwrap(recorder.spawns.first).arguments
        XCTAssertTrue(
            args.contains("--join=https://tray.test/join/x.secret"),
            "the follower attaches to the remote tray: \(args)"
        )
        XCTAssertFalse(args.contains("--lead"))
        XCTAssertTrue(process.isRunning(chrome))
        XCTAssertFalse(
            process.isLeaderReady(),
            "a browser attached to someone else's tray is not this device's leader"
        )
        XCTAssertTrue(process.isRunningAsFollower(chrome))
    }

    func testAFollowerUsesItsOwnPortsSoItCanSitBesideALeader() throws {
        let process = makeProcess()
        try process.launchStandalone(target("Chrome"))
        try process.launchBrowserFollower(target("Brave"), joinUrl: "https://tray.test/join/x.secret")

        let leaderArgs = recorder.spawns[0].arguments.joined(separator: " ")
        let followerArgs = recorder.spawns[1].arguments.joined(separator: " ")
        XCTAssertFalse(followerArgs.contains("--cdp-port=9222"), followerArgs)
        XCTAssertTrue(leaderArgs.contains("--cdp-port=9222"), leaderArgs)
    }

    func testAFollowerRefusesATerminalTargetAndAnEmptyJoinUrl() {
        let process = makeProcess()

        XCTAssertThrowsError(
            try process.launchBrowserFollower(
                target("Terminal", type: .terminal),
                joinUrl: "https://tray.test/join/x.secret"
            )
        ) { error in
            guard case SliccProcess.LaunchError.invalidTerminalTarget = error else {
                return XCTFail("expected invalidTerminalTarget, got \(error)")
            }
        }

        XCTAssertThrowsError(try process.launchBrowserFollower(target("Chrome"), joinUrl: "")) { error in
            guard case SliccProcess.LaunchError.leaderUnavailable = error else {
                return XCTFail("expected leaderUnavailable, got \(error)")
            }
        }
        XCTAssertTrue(recorder.spawns.isEmpty)
    }

    // MARK: - Electron apps

    func testAnElectronAppWaitsForALeaderBeforeItCanStart() {
        let process = makeProcess()
        let signal = target("Signal", type: .electronApp)

        XCTAssertEqual(process.runtimeState(for: signal), .cannotStart(.needsLeader))
        XCTAssertTrue(recorder.spawns.isEmpty)
    }

    func testAnElectronAppLaunchesAsAFollowerOfTheLocalLeader() throws {
        let process = makeProcess()
        try process.launchStandalone(target("Chrome"))
        process.leaderJoinUrl = "https://tray.test/join/local.secret"

        try process.launchWithElectronApp(target("Signal", type: .electronApp))

        XCTAssertEqual(recorder.spawns.count, 2)
        let args = recorder.spawns[1].arguments
        XCTAssertTrue(
            args.contains("--join=https://tray.test/join/local.secret"),
            "an Electron app attaches to the local leader: \(args)"
        )
        XCTAssertTrue(
            args.contains { $0.hasPrefix("--electron-app=") },
            "the server needs to know which app to attach to: \(args)"
        )
    }

    func testEachElectronAppGetsItsOwnPortPair() throws {
        let process = makeProcess()
        try process.launchStandalone(target("Chrome"))
        process.leaderJoinUrl = "https://tray.test/join/local.secret"

        try process.launchWithElectronApp(target("Signal", type: .electronApp))
        try process.launchWithElectronApp(target("Slack", type: .electronApp))

        let ports = recorder.spawns.dropFirst().map { spawn in
            spawn.arguments.first { $0.hasPrefix("--cdp-port=") } ?? "none"
        }
        XCTAssertEqual(Set(ports).count, 2, "two apps sharing a CDP port would collide: \(ports)")
    }

    // MARK: - Stopping

    func testStoppingEverythingClearsTheRecordsAndTheLeader() throws {
        let process = makeProcess()
        try process.launchStandalone(target("Chrome"))
        process.leaderJoinUrl = "https://tray.test/join/local.secret"
        XCTAssertTrue(process.isLeaderReady())

        process.stopAll()

        XCTAssertFalse(process.isRunning(target("Chrome")))
        XCTAssertFalse(process.isLeaderReady())
    }

    func testDetachingPersistsWhatAReattachNeeds() throws {
        let storeURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("detach-\(UUID().uuidString).json")
        let store = LaunchRecordStore(storeURL: storeURL)
        // `addTeardownBlock`, not `defer`: a deferred cleanup runs while an
        // error is still propagating and replaced the real failure with its
        // own "couldn't be removed", which is what CI reported instead of the
        // cause.
        addTeardownBlock { try? FileManager.default.removeItem(at: storeURL) }
        let process = makeProcess(records: store)
        try process.launchStandalone(target("Chrome"))

        let detached = process.detachAll()

        XCTAssertEqual(detached.count, 1)
        let persisted = store.load()
        XCTAssertEqual(persisted.count, 1)
        XCTAssertEqual(persisted.first?.cdpPort, 9222)
        XCTAssertEqual(
            persisted.first?.bridgeToken,
            detached.first?.bridgeToken,
            "reattach has to re-forward the same secret the surviving tab carries"
        )
    }

    func testDetachingTwiceDoesNotErasePersistedRecords() throws {
        let storeURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("detach-twice-\(UUID().uuidString).json")
        let store = LaunchRecordStore(storeURL: storeURL)
        // `addTeardownBlock`, not `defer`: a deferred cleanup runs while an
        // error is still propagating and replaced the real failure with its
        // own "couldn't be removed", which is what CI reported instead of the
        // cause.
        addTeardownBlock { try? FileManager.default.removeItem(at: storeURL) }
        let process = makeProcess(records: store)
        try process.launchStandalone(target("Chrome"))

        // The update flow calls detachAll from onBeginUpdate, and the delegate
        // calls it again from applicationWillTerminate.
        _ = process.detachAll()
        _ = process.detachAll()

        XCTAssertEqual(
            store.load().count,
            1,
            "the second call must not overwrite the snapshot with an empty one"
        )
    }
}
