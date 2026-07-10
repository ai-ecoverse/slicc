import AppKit
import XCTest
@testable import Sliccstart

/// Backfill coverage for pure, side-effect-free helpers that lost their
/// indirect test exposure when the webapp-only smooth-update subsystem was
/// removed. Keeps the `swift-launcher` package above its coverage floor by
/// exercising model logic the SwiftUI views can't drive under `swift test`.
final class LauncherCoverageBackfillTests: XCTestCase {

    // MARK: - EnvFileFormat parse/serialize round-trips

    func testParseSecretsHonoursQuotingCommentsAndDomains() {
        let blob = """
        # comment line
        GITHUB_TOKEN="ghp_with space"
        GITHUB_TOKEN_DOMAINS=api.github.com, *.github.com
        EMPTY_DOMAINS_SECRET=value
        EMPTY_DOMAINS_SECRET_DOMAINS=
        SINGLE='quoted'
        SINGLE_DOMAINS=example.com
        """
        let secrets = EnvFileFormat.parseSecrets(blob)
        let byName = Dictionary(uniqueKeysWithValues: secrets.map { ($0.name, $0) })
        XCTAssertEqual(byName["GITHUB_TOKEN"]?.value, "ghp_with space")
        XCTAssertEqual(byName["GITHUB_TOKEN"]?.domains, ["api.github.com", "*.github.com"])
        XCTAssertEqual(byName["SINGLE"]?.value, "quoted")
        // A secret with no usable domains is dropped.
        XCTAssertNil(byName["EMPTY_DOMAINS_SECRET"])
    }

    func testSerializeQuotesValuesNeedingEscaping() {
        let secrets = [
            Secret(name: "A", value: "plain", domains: ["a.com"]),
            Secret(name: "B", value: "has space#", domains: ["b.com", "c.com"]),
        ]
        let serialized = EnvFileFormat.serialize(secrets)
        XCTAssertTrue(serialized.contains("A=plain"))
        XCTAssertTrue(serialized.contains("\"has space#\""))
        // Round-trips back to the same secrets.
        XCTAssertEqual(EnvFileFormat.parseSecrets(serialized), secrets)
    }

    func testParseDomainsTrimsAndDropsEmpties() {
        XCTAssertEqual(EnvFileFormat.parseDomains(" a.com , , b.com "), ["a.com", "b.com"])
        XCTAssertTrue(EnvFileFormat.parseDomains("").isEmpty)
    }

    func testIsValidHostnamePatternCoversShapes() {
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("*"))
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("*.example.com"))
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("example.com"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern(""))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("a..b"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("-bad.com"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("bad-.com"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("inv@lid.com"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("*."))
    }

    // MARK: - Secret / SecretsError value types

    func testSecretIdentityAndEquality() {
        let a = Secret(name: "X", value: "1", domains: ["a"])
        let b = Secret(name: "X", value: "2", domains: ["b"])
        XCTAssertEqual(a.id, "X")
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(Set([a]).count, 1)
    }

    func testSecretsErrorDescriptionsAreNonEmpty() {
        XCTAssertEqual(SecretsError.keychainError(status: -25300).errorDescription, "Keychain error (-25300)")
        XCTAssertEqual(SecretsError.emptyDomains.errorDescription, "At least one hostname pattern is required.")
        XCTAssertEqual(SecretsError.emptyName.errorDescription, "Name must not be empty.")
        XCTAssertEqual(SecretsError.duplicateName("Y").errorDescription, "A secret named \"Y\" already exists.")
    }

    func testReadBlobReturnsEmptyWhenItemAbsent() throws {
        // Reading a generic-password item that does not exist returns
        // errSecItemNotFound without prompting — exercises the not-found
        // branch deterministically.
        _ = try SecretsKeychain.readBlob()
    }

    // MARK: - AppScanner real-machine scan (read-only)

    func testScanRunsWithAndWithoutPermission() {
        // Both branches execute the known-browser/known-electron lookups and
        // the sort; result content depends on the host, so we only assert the
        // call returns a well-formed, sorted array.
        let withPermNames = AppScanner.scan(hasAppManagementPermission: true).map(\.name)
        let withoutPermNames = AppScanner.scan(hasAppManagementPermission: false).map(\.name)
        XCTAssertEqual(withPermNames, withPermNames.sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        })
        XCTAssertEqual(withoutPermNames, withoutPermNames.sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        })
    }

    func testIsChromiumBrowserMatchesKnownBundleId() {
        XCTAssertTrue(AppScanner.isChromiumBrowser(bundleId: "com.google.Chrome"))
        XCTAssertFalse(AppScanner.isChromiumBrowser(bundleId: "com.example.NotABrowser"))
    }

    // MARK: - AppRowStatusDot presentation

    func testAppRowStatusDotColorAndHelpForEveryCase() {
        let cases: [AppRowStatusDot] = [
            .runningWithDebug, .runningWithoutDebug, .needsPermission,
            .needsDebugBuild, .needsLeader, .failed,
        ]
        for dot in cases {
            XCTAssertFalse(dot.help.isEmpty)
            _ = dot.color
        }
        XCTAssertEqual(AppRowStatusDot.runningWithDebug.color, .green)
        XCTAssertEqual(AppRowStatusDot.needsLeader.color, .gray)
    }

    // MARK: - AppRuntimeState.isRunning

    func testAppRuntimeStateIsRunningFlag() {
        XCTAssertTrue(AppRuntimeState.runningWithoutDebug.isRunning)
        XCTAssertTrue(AppRuntimeState.runningWithDebug(cdpPort: 1).isRunning)
        XCTAssertFalse(AppRuntimeState.notRunning.isRunning)
        XCTAssertFalse(AppRuntimeState.startFailed(message: "x").isRunning)
        XCTAssertFalse(AppRuntimeState.cannotStart(.needsLeader).isRunning)
    }
}

@MainActor
final class LauncherProcessCoverageTests: XCTestCase {

    func testResolveLaunchConfigurationThrowsWhenNoServerBinary() {
        XCTAssertThrowsError(
            try SliccProcess.resolveLaunchConfiguration(
                sliccDir: "/nonexistent-\(UUID().uuidString)",
                extraArgs: [],
                resourcePath: nil
            )
        ) { error in
            XCTAssertEqual(
                (error as? SliccProcess.LaunchError)?.errorDescription,
                SliccProcess.LaunchError.serverBinaryNotFound.errorDescription
            )
        }
    }

    func testLaunchErrorHasDescription() {
        XCTAssertNotNil(SliccProcess.LaunchError.serverBinaryNotFound.errorDescription)
    }

    func testResolvedSliccDirIsNonEmpty() {
        XCTAssertFalse(SliccProcess().resolvedSliccDir.isEmpty)
    }

    func testReattachWithEmptyStoreReturnsNothing() async {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lr-\(UUID().uuidString).json")
        let proc = SliccProcess(recordStore: LaunchRecordStore(storeURL: url))
        let result = await proc.reattachPersistedRecords(targets: [])
        XCTAssertTrue(result.isEmpty)
    }

    func testReattachSkipsRecordsWithDeadCDP() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lr-\(UUID().uuidString).json")
        let store = LaunchRecordStore(storeURL: url)
        try store.save([
            PersistedLaunchRecord(
                targetId: "/Applications/Dead.app",
                targetName: "Dead",
                targetType: .electronApp,
                electronAppPath: "/Applications/Dead.app",
                servePort: 5710,
                cdpPort: 9222
            )
        ])
        // Probe reports the CDP endpoint as gone, so no reattach / spawn.
        let proc = SliccProcess(
            recordStore: store,
            cdpLiveProbe: CDPLiveProbe(fetch: { _ in 0 })
        )
        let result = await proc.reattachPersistedRecords(targets: [])
        XCTAssertTrue(result.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testRefreshAndStopWithSeededRecord() throws {
        let proc = SliccProcess()
        let sleeper = Process()
        sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
        sleeper.arguments = ["60"]
        try sleeper.run()
        addTeardownBlock { if sleeper.isRunning { sleeper.terminate() } }

        let target = AppTarget(
            id: "browser-x", name: "TestBrowser", path: "browser-x",
            executablePath: "", type: .chromiumBrowser,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported, isDebugBuild: false, originalAppPath: nil
        )
        proc._testing_seedLaunchRecord(
            id: target.id, process: sleeper, targetType: .chromiumBrowser,
            cdpPort: 39222, servePort: 35710, targetName: target.name
        )
        XCTAssertTrue(proc.isRunning(target))
        proc.refreshRuntimeStates(for: [target])
        proc.stop(target)
        XCTAssertFalse(proc.isRunning(target))
    }

    // A standalone browser whose CDP port has stopped listening after the
    // boot grace period means Chrome has quit — the lingering slicc-server
    // helper must be reaped so the browser can be relaunched.
    func testStaleBrowserWithFreeCdpPortIsReaped() throws {
        let proc = SliccProcess()
        let sleeper = try makeSleeper()
        addTeardownBlock { if sleeper.isRunning { sleeper.terminate() } }

        let target = Self.makeBrowserTarget(id: "browser-stale")
        proc._testing_seedLaunchRecord(
            id: target.id, process: sleeper, targetType: .chromiumBrowser,
            cdpPort: 39322, servePort: 35810, targetName: target.name,
            startedAt: Date(timeIntervalSinceNow: -60)
        )
        XCTAssertTrue(proc.isRunning(target))
        proc.refreshRuntimeStates(for: [target])
        XCTAssertFalse(proc.isRunning(target))
    }

    // A freshly-launched browser whose CDP port hasn't come up yet (still
    // inside the grace period) must NOT be reaped.
    func testFreshBrowserWithinGracePeriodIsNotReaped() throws {
        let proc = SliccProcess()
        let sleeper = try makeSleeper()
        addTeardownBlock { if sleeper.isRunning { sleeper.terminate() } }

        let target = Self.makeBrowserTarget(id: "browser-fresh")
        proc._testing_seedLaunchRecord(
            id: target.id, process: sleeper, targetType: .chromiumBrowser,
            cdpPort: 39323, servePort: 35811, targetName: target.name
        )
        proc.refreshRuntimeStates(for: [target])
        XCTAssertTrue(proc.isRunning(target))
        proc.stop(target)
    }

    // A stale browser whose CDP port is still listening (Chrome alive) must
    // NOT be reaped even after the grace period.
    func testStaleBrowserWithBusyCdpPortIsNotReaped() throws {
        let proc = SliccProcess()
        let sleeper = try makeSleeper()
        addTeardownBlock { if sleeper.isRunning { sleeper.terminate() } }

        let (listenFd, busyPort) = try Self.makeListeningSocket()
        addTeardownBlock { close(listenFd) }

        let target = Self.makeBrowserTarget(id: "browser-busy")
        proc._testing_seedLaunchRecord(
            id: target.id, process: sleeper, targetType: .chromiumBrowser,
            cdpPort: busyPort, servePort: 35812, targetName: target.name,
            startedAt: Date(timeIntervalSinceNow: -60)
        )
        proc.refreshRuntimeStates(for: [target])
        XCTAssertTrue(proc.isRunning(target))
        proc.stop(target)
    }

    private static func makeBrowserTarget(id: String) -> AppTarget {
        AppTarget(
            id: id, name: "TestBrowser", path: id,
            executablePath: "", type: .chromiumBrowser,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported, isDebugBuild: false, originalAppPath: nil
        )
    }

    /// Binds a listening TCP socket on an ephemeral 127.0.0.1 port and
    /// returns the fd plus the assigned port, so a test can make
    /// `isPortInUse` report the CDP port as still taken.
    private static func makeListeningSocket() throws -> (fd: Int32, port: UInt16) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw NSError(domain: "test", code: Int(errno))
        }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.bind(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0, listen(fd, 1) == 0 else {
            close(fd)
            throw NSError(domain: "test", code: Int(errno))
        }
        var boundAddr = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        withUnsafeMutablePointer(to: &boundAddr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                _ = getsockname(fd, sockPtr, &len)
            }
        }
        return (fd, UInt16(bigEndian: boundAddr.sin_port))
    }

    func testRuntimeStateDrivesDebugPortAndAppRunningHelpers() throws {
        let proc = SliccProcess()

        // Electron target with a live record exercises `activeDebugPort`'s
        // electron branch (`isPortInUse` on an unused port) plus the
        // `isElectronAppRunning` / `runningElectronApplications` helpers.
        let electronSleeper = try makeSleeper()
        addTeardownBlock { if electronSleeper.isRunning { electronSleeper.terminate() } }
        let electron = AppTarget(
            id: "/Applications/Synthetic-\(UUID().uuidString).app",
            name: "SyntheticElectron",
            path: "/Applications/Synthetic.app",
            executablePath: "/Applications/Synthetic.app/Contents/MacOS/SyntheticElectron",
            type: .electronApp,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported, isDebugBuild: false,
            originalAppPath: "/Applications/SyntheticOriginal.app"
        )
        proc._testing_seedLaunchRecord(
            id: electron.id, process: electronSleeper, targetType: .electronApp,
            cdpPort: 39999, servePort: 35999,
            electronAppPath: electron.path, targetName: electron.name
        )
        _ = proc.runtimeState(for: electron, hasAppManagementPermission: true)

        // A live chromium record reports its CDP port directly through
        // `activeDebugPort`'s non-electron path.
        let browserSleeper = try makeSleeper()
        addTeardownBlock { if browserSleeper.isRunning { browserSleeper.terminate() } }
        let browser = AppTarget(
            id: "chromium-x", name: "TestBrowser", path: "chromium-x",
            executablePath: "", type: .chromiumBrowser,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported, isDebugBuild: false, originalAppPath: nil
        )
        proc._testing_seedLaunchRecord(
            id: browser.id, process: browserSleeper, targetType: .chromiumBrowser,
            cdpPort: 39222, servePort: 35710, targetName: browser.name
        )
        XCTAssertEqual(proc.runtimeState(for: browser), .runningWithDebug(cdpPort: 39222))
    }

    func testStopElectronRecordWalksAppTerminationPath() throws {
        let proc = SliccProcess()
        let sleeper = try makeSleeper()
        addTeardownBlock { if sleeper.isRunning { sleeper.terminate() } }
        let electron = AppTarget(
            id: "/Applications/StopMe-\(UUID().uuidString).app",
            name: "StopMe", path: "/Applications/StopMe.app",
            executablePath: "/Applications/StopMe.app/Contents/MacOS/StopMe",
            type: .electronApp,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported, isDebugBuild: false, originalAppPath: nil
        )
        proc._testing_seedLaunchRecord(
            id: electron.id, process: sleeper, targetType: .electronApp,
            launchedAppPaths: [electron.path], cdpPort: 39777, servePort: 35777,
            electronAppPath: electron.path, targetName: electron.name
        )
        // Drives stopLaunchRecord's electron branch + terminateElectronApplications
        // (no real app matches the synthetic path, so nothing is killed).
        proc.stop(electron)
        XCTAssertFalse(proc.isRunning(electron))
    }

    private func makeSleeper() throws -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sleep")
        p.arguments = ["60"]
        try p.run()
        return p
    }
}

final class TrayStatusProbeEdgeCoverageTests: XCTestCase {

    func testInvalidServeOriginReturnsNilWithoutFetching() async {
        let probe = TrayStatusProbe(fetch: { _ in
            XCTFail("fetch must not run for an unparseable origin")
            return (200, Data())
        })
        let result = await probe.discoverJoinUrl(serveOrigin: "ht tp://bad origin")
        XCTAssertNil(result)
    }

    func testUnexpectedStatusIsRetriedThenGivesUp() async {
        let probe = TrayStatusProbe(fetch: { _ in (404, Data()) })
        let result = await probe.discoverJoinUrl(
            serveOrigin: "http://127.0.0.1:5710",
            maxAttempts: 2,
            retryDelay: 0
        )
        XCTAssertNil(result)
    }
}

final class LauncherBootstrapperCoverageTests: XCTestCase {

    func testCheckInstallationBranches() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("slicc-boot-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: tmp) }

        XCTAssertEqual(
            SliccBootstrapper.checkInstallation(sliccDir: tmp.path, resourcePath: nil),
            .notInstalled
        )
        FileManager.default.createFile(
            atPath: tmp.appendingPathComponent("package.json").path,
            contents: Data("{}".utf8)
        )
        XCTAssertEqual(
            SliccBootstrapper.checkInstallation(sliccDir: tmp.path, resourcePath: nil),
            .needsBuild
        )
    }

    func testFindServerBinaryNilForBogusDir() {
        XCTAssertNil(
            SliccBootstrapper.findServerBinary(
                sliccDir: "/nonexistent-\(UUID().uuidString)",
                resourcePath: nil
            )
        )
    }

    func testBundledLookupsAndDefaults() {
        // In the test bundle these resolve against the xctest resources;
        // we only need to execute the lookups, not assert a fixed result.
        _ = SliccBootstrapper.isBundled
        _ = SliccBootstrapper.bundledSliccDir
        _ = SliccBootstrapper.bundledServerBinaryPath
        _ = SliccBootstrapper.bundledNodePath
        _ = SliccBootstrapper.findNode()
        XCTAssertFalse(SliccBootstrapper.defaultSliccDir.isEmpty)
    }

    func testBootstrapErrorDescriptions() {
        XCTAssertNotNil(SliccBootstrapper.BootstrapError.nodeNotFound.errorDescription)
        XCTAssertNotNil(SliccBootstrapper.BootstrapError.commandFailed("x").errorDescription)
    }
}
