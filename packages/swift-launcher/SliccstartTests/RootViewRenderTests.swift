import AppKit
import AppUpdater
import SliccTrayFollower
import SliccTraySession
import SliccWidgetKit
import SwiftUI
import XCTest

@testable import Sliccstart

/// The launcher window's three faces — setup progress, debug-build progress,
/// and the app list — which used to be a `Group` inside `SliccstartApp`'s
/// `WindowGroup` and therefore unrenderable (an `App`'s `Scene` is not a
/// `View`). Now it is `RootView`, so each state can be driven and compared.
@MainActor
final class RootViewRenderTests: XCTestCase {
    private var container: URL!
    private var suiteName: String!

    override func setUp() async throws {
        container = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("root-view-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        suiteName = "sliccstart.tests.rootview.\(UUID().uuidString)"
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: container)
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
    }

    /// `scanApps` returns the same targets the model is seeded with: the App
    /// Management permission probe settles asynchronously, and `RootView`
    /// rescans when it does — a stub that returned `[]` would wipe the seed
    /// mid-render and quietly turn every comparison into "empty vs empty".
    private func model(
        process: SliccProcess = SliccProcess(),
        targets: [AppTarget] = []
    ) -> LauncherModel {
        let model = LauncherModel(
            process: process,
            sessionStore: TraySessionSyncStore(
                backend: InMemoryKeyValueBackend(),
                deviceId: "this-device",
                deviceName: "This Mac"
            ),
            fileProviderCoordinator: FileProviderCoordinator(
                defaults: UserDefaults(suiteName: suiteName)!
            ),
            widgetTrayObserver: WidgetTrayObserver(
                publisher: WidgetSnapshotPublisher(
                    store: WidgetSnapshotStore(appGroup: "test") { [container] _ in container! },
                    minimumInterval: 0
                ),
                installation: WidgetInstallationQuery { false },
                makeConnector: { _ in InertConnector() }
            ),
            updateChecking: .init(check: { _, _ in }, isUpdateReady: { false }),
            scanApps: { _ in targets },
            checkInstallation: { _ in .installed },
            makeDebugBuild: { path, _ in path },
            isBundledBuild: { false },
            startupLaunchEnabled: { false },
            savedBrowserOrder: { [] }
        )
        model.targets = targets
        return model
    }

    private func view(_ model: LauncherModel) -> RootView {
        RootView(
            model: model,
            appUpdater: AppUpdater(owner: "ai-ecoverse", repo: "slicc", releasePrefix: "Sliccstart"),
            isBundledBuild: true
        )
    }

    private func target(_ name: String) -> AppTarget {
        // A drawn icon, not a bare NSImage(size:): SwiftUI renders an image
        // with no representations as nothing, which would make a populated
        // list indistinguishable from an empty one.
        let icon = NSImage(size: NSSize(width: 16, height: 16))
        icon.lockFocus()
        NSColor.systemBlue.setFill()
        NSRect(x: 0, y: 0, width: 16, height: 16).fill()
        icon.unlockFocus()
        return AppTarget(
            id: "/Applications/\(name).app",
            name: name,
            path: "/Applications/\(name).app",
            executablePath: "/Applications/\(name).app/Contents/MacOS/\(name)",
            type: .chromiumBrowser,
            icon: icon,
            debugSupport: .unknown,
            isDebugBuild: false,
            originalAppPath: nil,
            bundleId: "com.google.Chrome"
        )
    }

    func testTheWindowShowsSetupProgressUntilItIsReady() {
        let starting = model()
        let ready = model()
        ready.isReady = true

        ViewHosting.assertRendersDifferently(
            view(starting),
            view(ready),
            "the app list must not appear before the runtime is checked",
            width: 340,
            height: 420
        )
    }

    func testSetupProgressCarriesTheBootstrapperMessageAndError() {
        let quiet = model()
        let working = model()
        working.bootstrapper.progressMessage = "Cloning slicc…"
        working.bootstrapper.isWorking = true
        let failed = model()
        failed.bootstrapper.progressMessage = "no network"
        failed.bootstrapper.lastError = "no network"

        let digests = [quiet, working, failed].map {
            ViewHosting.digest(of: view($0), width: 340, height: 420)
        }
        XCTAssertEqual(
            Set(digests).count,
            3,
            "checking / working / failed must each say something different"
        )
    }

    func testCreatingADebugBuildTakesOverTheWindow() {
        let listed = model()
        listed.isReady = true
        let building = model()
        building.isReady = true
        building.isCreatingDebugBuild = true
        building.debugBuildProgress = "Patching fuses"

        ViewHosting.assertRendersDifferently(
            view(listed),
            view(building),
            "a debug build in flight replaces the list with its own progress",
            width: 340,
            height: 420
        )
    }

    func testTheDebugBuildScreenFallsBackToADefaultMessage() {
        let named = model()
        named.isReady = true
        named.isCreatingDebugBuild = true
        named.debugBuildProgress = "Unpacking app.asar"
        let unnamed = model()
        unnamed.isReady = true
        unnamed.isCreatingDebugBuild = true

        ViewHosting.assertRendersDifferently(view(named), view(unnamed), width: 340, height: 420)
    }

    func testTheReadyWindowRendersTheScannedApps() {
        let empty = model()
        empty.isReady = true
        let scanned = model(targets: [target("Chrome")])
        scanned.isReady = true

        ViewHosting.assertRendersDifferently(
            view(empty),
            view(scanned),
            width: 340,
            height: 520
        )
    }

    func testTheReadyWindowReflectsTheUpdateStatus() {
        let idle = model()
        idle.isReady = true
        let failed = model()
        failed.isReady = true
        failed.updateCheckStatus = .failed("rate limited")

        ViewHosting.assertRendersDifferently(view(idle), view(failed), width: 340, height: 520)
    }
}

@MainActor
private final class InertConnector: WidgetTrayConnecting {
    weak var delegate: TrayFollowerConnectorDelegate?
    func start() async throws {}
    func stop() {}
}
