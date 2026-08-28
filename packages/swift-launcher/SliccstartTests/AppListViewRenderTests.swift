import AppKit
import AppUpdater
import SliccTraySession
import Version
import SwiftUI
import XCTest

@testable import Sliccstart

/// `AppListView` — the launcher's main window content — driven through real
/// (off-screen) SwiftUI renders.
///
/// Every branch in this window is a `body` branch: which sections a given scan
/// produces, whether a row is disabled without a leader, what the update footer
/// offers, how an unreachable iCloud session is drawn. Rendering each state and
/// comparing the results is the only way to reach that code, and comparing
/// renders (rather than asserting on pixels) keeps the assertions meaningful
/// without pinning them to a machine or an OS version.
///
/// The button *actions* these rows trigger live in `AppListActions` and are
/// tested directly in `AppListActionsTests` — headless SwiftUI exposes no
/// pressable control (see `ViewHosting`).
@MainActor
final class AppListViewRenderTests: XCTestCase {

    // MARK: - Fixtures

    private func icon() -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16))
        image.lockFocus()
        NSColor.systemBlue.setFill()
        NSRect(x: 0, y: 0, width: 16, height: 16).fill()
        image.unlockFocus()
        return image
    }

    private func target(
        _ name: String,
        type: AppTargetType,
        bundleId: String? = nil,
        debugSupport: ElectronDebugSupport = .unknown,
        isDebugBuild: Bool = false
    ) -> AppTarget {
        AppTarget(
            id: "/Applications/\(name).app",
            name: name,
            path: "/Applications/\(name).app",
            executablePath: "/Applications/\(name).app/Contents/MacOS/\(name)",
            type: type,
            icon: icon(),
            debugSupport: debugSupport,
            isDebugBuild: isDebugBuild,
            originalAppPath: nil,
            bundleId: bundleId ?? "com.test.\(name.lowercased())"
        )
    }

    private func store(remote: [SyncedTraySession] = []) -> TraySessionSyncStore {
        let backend = InMemoryKeyValueBackend()
        if !remote.isEmpty, let encoded = try? JSONEncoder().encode(remote) {
            // Remote sessions live under another device's key, so the store
            // reads them back as "published elsewhere".
            backend.setData(encoded, forKey: TraySessionSyncStore.storageKeyPrefix + "other-device")
        }
        return TraySessionSyncStore(
            backend: backend,
            deviceId: "this-device",
            deviceName: "This Mac"
        )
    }

    private func session(
        label: String,
        deviceId: String = "other-device",
        deviceName: String = "MacBook"
    ) -> SyncedTraySession {
        SyncedTraySession(
            joinUrl: "https://tray.test/join/\(label.lowercased()).secret",
            label: label,
            deviceId: deviceId,
            deviceName: deviceName,
            createdAt: Date(timeIntervalSince1970: 1_800_000_000),
            lastSeenAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
    }

    private func updater() -> AppUpdater {
        AppUpdater(owner: "ai-ecoverse", repo: "slicc", releasePrefix: "Sliccstart")
    }

    /// An updater holding a staged build, which is the only state in which the
    /// footer offers "Restart to Update" — and therefore the only state in
    /// which the agent-activity tint is read at all.
    private func updaterWithDownloadedUpdate(version: String = "6.105.0") throws -> AppUpdater {
        let json = """
            {
              "tag_name": "v\(version)",
              "prerelease": false,
              "name": "v\(version)",
              "html_url": "https://github.com/ai-ecoverse/slicc/releases/tag/v\(version)",
              "body": "test",
              "assets": [{
                "name": "Sliccstart-\(version).zip",
                "browser_download_url": "https://example.com/Sliccstart-\(version).zip",
                "content_type": "application/zip"
              }]
            }
            """
        let decoder = JSONDecoder()
        decoder.userInfo[.decodingMethod] = DecodingMethod.tolerant
        let release = try decoder.decode(Release.self, from: Data(json.utf8))
        let asset = try XCTUnwrap(release.assets.first)
        let updater = updater()
        updater.state = .downloaded(release, asset, Bundle.main)
        return updater
    }

    private func makeView(
        targets: [AppTarget],
        process: SliccProcess = SliccProcess(),
        sessionStore: TraySessionSyncStore? = nil,
        permission: AppManagementPermission = AppManagementPermission(),
        updateCheckStatus: UpdateCheckStatus = .idle,
        hasRecentAgentActivity: Bool = false,
        isBundledBuild: Bool = true,
        appUpdater: AppUpdater? = nil
    ) -> AppListView {
        AppListView(
            targets: targets,
            sliccProcess: process,
            sessionStore: sessionStore ?? store(),
            appManagementPermission: permission,
            appUpdater: appUpdater ?? updater(),
            updateCheckStatus: updateCheckStatus,
            hasRecentAgentActivity: hasRecentAgentActivity,
            onCheckForUpdates: {},
            onLaunchStandalone: { _ in },
            onLaunchBrowserFollower: { _, _ in },
            onLaunchElectron: { _ in },
            onCreateDebugBuild: { _ in },
            onUpdate: {},
            onBeginUpdate: {},
            onRescan: {},
            isBundledBuild: isBundledBuild
        )
    }

    private let browser = "Chrome"
    private let terminal = "Terminal"
    private let electron = "Signal"

    private func mixedScan() -> [AppTarget] {
        [
            target(browser, type: .chromiumBrowser, bundleId: "com.google.Chrome"),
            target(terminal, type: .terminal, bundleId: "com.apple.Terminal"),
            target(electron, type: .electronApp, debugSupport: .supported),
        ]
    }

    // MARK: - Sections

    func testEachScannedAppTypeAddsItsOwnSection() {
        // Every section is conditional on the scan, so each combination is a
        // distinct body — and an empty scan still has to produce a window.
        let empty = digestOf(makeView(targets: []))
        let browsersOnly = digestOf(
            makeView(targets: [target(browser, type: .chromiumBrowser, bundleId: "com.google.Chrome")])
        )
        let full = digestOf(makeView(targets: mixedScan()))

        XCTAssertNotEqual(empty, browsersOnly, "a scanned browser must add a Browsers section")
        XCTAssertNotEqual(browsersOnly, full, "terminals and desktop apps must add their sections")
        XCTAssertEqual(
            digestOf(makeView(targets: mixedScan())),
            full,
            "the same scan must render deterministically"
        )
    }

    func testTheExtensionSectionIsAlwaysOfferedEvenWithNothingInstalled() {
        XCTAssertEqual(AppListSection.visibleSections(for: []), [.browserExtension])
        // ...and it renders: an empty scan is not a blank window.
        XCTAssertFalse(digestOf(makeView(targets: [])).isEmpty)
    }

    func testDebugBuildBadgeChangesHowARowIsDrawn() {
        let plain = makeView(targets: [target(electron, type: .electronApp, debugSupport: .supported)])
        let patched = makeView(
            targets: [
                target(electron, type: .electronApp, debugSupport: .supported, isDebugBuild: true)
            ]
        )
        ViewHosting.assertRendersDifferently(
            plain,
            patched,
            "a debug build must be badged in the list"
        )
    }

    func testElectronAppNeedingADebugBuildRendersDifferentlyFromOneThatDoesNot() {
        let ready = makeView(targets: [target(electron, type: .electronApp, debugSupport: .supported)])
        let needsBuild = makeView(
            targets: [target(electron, type: .electronApp, debugSupport: .disabled)]
        )
        ViewHosting.assertRendersDifferently(ready, needsBuild)
    }

    // MARK: - Runtime state

    func testALeaderUngatesTheRowsThatNeedOne() throws {
        // Desktop apps and terminals stay disabled until a browser leader is
        // BOTH running and has published a join URL — the single gate this
        // window is built around.
        let scan = mixedScan()
        let gated = SliccProcess()
        let ungated = SliccProcess()
        let helper = try launchSleeper()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }
        ungated._testing_seedLaunchRecord(
            id: "browser-1",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "TestBrowser"
        )
        ungated.leaderJoinUrl = "https://example.test/join/abc.def"
        XCTAssertTrue(ungated.isLeaderReady())

        ViewHosting.assertRendersDifferently(
            makeView(targets: scan, process: gated),
            makeView(targets: scan, process: ungated),
            "rows gated on a leader must visibly change once one exists"
        )
    }

    private func launchSleeper() throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["60"]
        try process.run()
        return process
    }

    func testEveryRuntimeStateRendersItsOwnRow() {
        let chrome = target(browser, type: .chromiumBrowser, bundleId: "com.google.Chrome")
        let states: [AppRuntimeState] = [
            .notRunning,
            .runningWithoutDebug,
            .runningWithDebug(cdpPort: 9222),
            .runningWithDebug(cdpPort: nil),
            .startFailed(message: "boom"),
            .cannotStart(.needsDebugBuild),
            .cannotStart(.needsPermission),
            .cannotStart(.needsLeader),
        ]
        var seen: Set<String> = []
        for state in states {
            let row = AppRow(
                target: chrome,
                runtimeState: state,
                onLaunch: {},
                onCreateDebugBuild: nil
            )
            seen.insert(digestOf(row, width: 400, height: 44))
        }
        // Not every state is visually unique (two share a dot colour), but a
        // single render for all eight would mean the state never reaches the UI.
        XCTAssertGreaterThan(seen.count, 4, "runtime states are not reaching the row")
    }

    func testTerminalSubtitleFollowsTheFollowerLaunchState() {
        let term = target(terminal, type: .terminal, bundleId: "com.apple.Terminal")
        let idle = SliccProcess()
        let launching = SliccProcess()
        launching.isLaunchingTerminalFollower = true

        ViewHosting.assertRendersDifferently(
            makeView(targets: [term], process: idle),
            makeView(targets: [term], process: launching),
            "a terminal mid-launch must say so"
        )
    }

    // MARK: - Update footer

    func testUpdateFooterRendersEveryCheckStatus() {
        let statuses: [UpdateCheckStatus] = [
            .idle, .checking, .upToDate, .noInstallableRelease, .translocated, .failed("network down"),
        ]
        var digests: [String: String] = [:]
        for status in statuses {
            digests[status.buttonTitle] = digestOf(makeView(targets: [], updateCheckStatus: status))
        }
        // Six distinct titles must produce six distinct footers.
        XCTAssertEqual(Set(digests.values).count, statuses.count, "\(digests.keys)")
    }

    func testAnUnbundledBuildOffersOnlyAPlainUpdateButton() {
        // Running from a source build there is nothing for the in-app updater
        // to replace, so the footer collapses to a single "Update" affordance
        // and the check status stops mattering.
        let idle = makeView(targets: [], updateCheckStatus: .idle, isBundledBuild: false)
        let failed = makeView(
            targets: [],
            updateCheckStatus: .failed("network down"),
            isBundledBuild: false
        )
        XCTAssertEqual(digestOf(idle), digestOf(failed))
        ViewHosting.assertRendersDifferently(
            idle,
            makeView(targets: [], updateCheckStatus: .idle, isBundledBuild: true),
            "a bundled build must offer the real update flow"
        )
    }

    func testAStagedUpdateOffersRestartInsteadOfAnotherCheck() throws {
        let staged = try updaterWithDownloadedUpdate()
        ViewHosting.assertRendersDifferently(
            makeView(targets: []),
            makeView(targets: [], appUpdater: staged),
            "a downloaded update must replace the check button with restart-to-update"
        )
    }

    func testAgentActivityDiscouragesRestartingIntoTheUpdate() throws {
        // The tint is read only by the restart button, and that button is
        // `.borderless` — AppKit-backed, so it draws nothing under
        // `ImageRenderer` and no render comparison can see it. The decision
        // is asserted directly instead; the render below only proves the
        // staged-update footer still builds in both states.
        XCTAssertEqual(
            AppListView.updateAffordance(hasRecentAgentActivity: false),
            .ready
        )
        XCTAssertEqual(
            AppListView.updateAffordance(hasRecentAgentActivity: true),
            .discouraged,
            "restarting mid-run would interrupt the agent, so it must not look inviting"
        )

        for busy in [false, true] {
            let view = makeView(
                targets: [],
                hasRecentAgentActivity: busy,
                appUpdater: try updaterWithDownloadedUpdate()
            )
            XCTAssertFalse(digestOf(view).isEmpty)
        }
    }

    func testAStagedUpdateWithoutAVersionStillOffersRestart() throws {
        // `fullUpdateButton` falls back to an unversioned title when the
        // bundle carries no CFBundleShortVersionString — the test bundle does
        // not, so this is the branch that actually renders here.
        let staged = try updaterWithDownloadedUpdate()
        XCTAssertFalse(digestOf(makeView(targets: [], appUpdater: staged)).isEmpty)
    }

    // MARK: - iCloud sessions

    func testSessionsSectionAppearsOnlyOnceSomethingIsAdvertised() {
        let none = makeView(targets: [])
        let one = makeView(targets: [], sessionStore: store(remote: [session(label: "Chrome")]))
        ViewHosting.assertRendersDifferently(none, one, "an advertised session must show a row")
    }

    func testMoreSessionsMeansMoreRows() {
        let one = makeView(targets: [], sessionStore: store(remote: [session(label: "Chrome")]))
        let two = makeView(
            targets: [],
            sessionStore: store(remote: [session(label: "Chrome"), session(label: "Edge")])
        )
        ViewHosting.assertRendersDifferently(one, two)
    }

    func testALocalBrowserMatchingASessionLendsItsIcon() {
        // `localBrowserIcon(for:)` matches an installed browser by the label the
        // publisher advertised, so the row shows the real app icon.
        let remote = session(label: browser)
        let sessionStore = store(remote: [remote])
        let withBrowser = makeView(
            targets: [target(browser, type: .chromiumBrowser, bundleId: "com.google.Chrome")],
            sessionStore: sessionStore
        )
        let withoutBrowser = makeView(targets: [], sessionStore: sessionStore)
        ViewHosting.assertRendersDifferently(withBrowser, withoutBrowser)
    }

    // MARK: - TraySessionRow

    func testUnreachableSessionRowIsDimmedAndItsRemoteActionsDisabled() {
        let row = { (verdict: SessionReachability.Verdict?) in
            TraySessionRow(
                session: self.session(label: "Chrome"),
                isLocal: false,
                localBrowserIcon: nil,
                verdict: verdict,
                canAttachBrowser: true,
                canFollow: true,
                onCopy: {},
                onAttachBrowser: {},
                onFollow: {}
            )
        }
        ViewHosting.assertRendersDifferently(
            row(.reachable),
            row(.unreachable),
            "an unreachable session must be dimmed",
            width: 420,
            height: 60
        )
        XCTAssertEqual(ViewHosting.hostedButtons(row(.reachable)).filter(\.isEnabled).count, 3)
        XCTAssertEqual(ViewHosting.hostedButtons(row(.unreachable)).filter(\.isEnabled).count, 1)
    }

    func testLocalSessionRowDropsTheRemoteActions() {
        let local = TraySessionRow(
            session: session(label: "Chrome", deviceId: "this-device", deviceName: "This Mac"),
            isLocal: true,
            localBrowserIcon: nil,
            verdict: nil,
            canAttachBrowser: false,
            canFollow: false,
            onCopy: {},
            onAttachBrowser: {},
            onFollow: {}
        )
        // Copy only — a session published from this device cannot be attached
        // to or followed from the same machine.
        XCTAssertEqual(ViewHosting.hostedButtons(local).count, 1)
    }

    func testSessionRowUsesTheLocalBrowserIconWhenThereIsOne() {
        let row = { (icon: NSImage?) in
            TraySessionRow(
                session: self.session(label: "Chrome"),
                isLocal: false,
                localBrowserIcon: icon,
                verdict: .reachable,
                canAttachBrowser: true,
                canFollow: true,
                onCopy: {},
                onAttachBrowser: {},
                onFollow: {}
            )
        }
        ViewHosting.assertRendersDifferently(row(nil), row(icon()), width: 420, height: 60)
    }

    // MARK: - AppRow

    func testAppRowRendersEveryStatusDot() {
        let chrome = target(browser, type: .chromiumBrowser, bundleId: "com.google.Chrome")
        let row = { (state: AppRuntimeState) in
            AppRow(target: chrome, runtimeState: state, onLaunch: {}, onCreateDebugBuild: nil)
        }
        ViewHosting.assertRendersDifferently(
            row(.notRunning),
            row(.runningWithDebug(cdpPort: 9222)),
            "a running app must show its status dot",
            width: 400,
            height: 44
        )
        ViewHosting.assertRendersDifferently(
            row(.startFailed(message: "boom")),
            row(.cannotStart(.needsLeader)),
            width: 400,
            height: 44
        )
    }

    func testAppRowSubtitleOverrideWins() {
        let chrome = target(browser, type: .chromiumBrowser, bundleId: "com.google.Chrome")
        let plain = AppRow(
            target: chrome,
            runtimeState: .notRunning,
            onLaunch: {},
            onCreateDebugBuild: nil
        )
        let overridden = AppRow(
            target: chrome,
            runtimeState: .notRunning,
            onLaunch: {},
            onCreateDebugBuild: nil,
            subtitleOverride: "Opening terminal…"
        )
        ViewHosting.assertRendersDifferently(plain, overridden, width: 400, height: 44)
    }

    func testSectionHeaderRenders() {
        XCTAssertFalse(digestOf(SectionHeader("Browsers"), width: 300, height: 30).isEmpty)
    }

    // MARK: - Helpers

    private func digestOf(_ view: some View, width: CGFloat = 520, height: CGFloat = 700) -> String {
        ViewHosting.digest(of: view, width: width, height: height)
    }
}
