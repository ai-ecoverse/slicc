import AppKit
import AppUpdater
import SliccTraySession
import XCTest

@testable import Sliccstart

@MainActor
final class AppDelegateLifecycleTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "sliccstart.tests.delegate.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func makeDelegate(
        process: LifecycleProcess = LifecycleProcess()
    ) -> (SliccstartAppDelegate, LifecycleProcess, TraySessionSyncStore) {
        let store = TraySessionSyncStore(
            backend: InMemoryKeyValueBackend(),
            deviceId: "this-device",
            deviceName: "This Mac"
        )
        let delegate = SliccstartAppDelegate(
            sliccProcess: process,
            sessionStore: store,
            fileProviderCoordinator: FileProviderCoordinator(defaults: defaults),
            appUpdater: AppUpdater(owner: "ai-ecoverse", repo: "slicc", releasePrefix: "Sliccstart")
        )
        return (delegate, process, store)
    }

    private var terminationNotice: Notification {
        Notification(name: NSApplication.willTerminateNotification)
    }

    func testAPlainQuitStopsEveryRuntimeAndUnadvertisesTheSession() {
        let (delegate, process, store) = makeDelegate()
        store.publish(joinUrl: "https://tray.test/join/x.secret", label: "Chrome")
        XCTAssertEqual(store.localSessions.count, 1)

        delegate.applicationWillTerminate(terminationNotice)

        XCTAssertEqual(process.stopAllCalls, 1)
        XCTAssertEqual(process.detachCalls, 0)
        XCTAssertTrue(
            store.localSessions.isEmpty,
            "another device must not be offered a session whose leader just died"
        )
    }

    func testQuittingForAnUpdateDetachesAndKeepsTheSessionAdvertised() {
        let (delegate, process, store) = makeDelegate()
        store.publish(joinUrl: "https://tray.test/join/x.secret", label: "Chrome")
        process.isPreparingForUpdate = true

        delegate.applicationWillTerminate(terminationNotice)

        XCTAssertEqual(process.detachCalls, 1)
        XCTAssertEqual(
            process.stopAllCalls,
            0,
            "the whole point of the update path is that the browsers keep running"
        )
        XCTAssertEqual(
            store.localSessions.count,
            1,
            "the tray stays live across the relaunch, so it stays advertised"
        )
    }

    func testTheDelegateIsConstructibleFromTheObjCRuntime() {
        let type: NSObject.Type = SliccstartAppDelegate.self
        let instance = type.init()
        XCTAssertTrue(
            instance is SliccstartAppDelegate,
            "the app delegate must answer -init, or SwiftUI cannot build it"
        )
    }

    func testTheDelegateBuildsTheWindowModelOverItsOwnCollaborators() {
        let (delegate, process, store) = makeDelegate()
        XCTAssertTrue(delegate.model.process === process)
        XCTAssertTrue(delegate.model.sessionStore === store)
        XCTAssertTrue(delegate.model.fileProviderCoordinator === delegate.fileProviderCoordinator)
    }

    func testIncomingLinksAreRoutedThroughTheLeaderBrowser() async {
        let (delegate, process, _) = makeDelegate()

        delegate.application(
            NSApplication.shared,
            open: [URL(string: "https://example.test/one")!, URL(string: "https://example.test/two")!]
        )

        for _ in 0..<8 { await Task.yield() }

        XCTAssertTrue(
            process.standaloneLaunches.count + process.openedUrls.count > 0
                || process.isLeaderReadyCalls > 0,
            "an incoming link must reach the leader path, not be swallowed"
        )
    }
}

private final class LifecycleProcess: SliccProcess {
    var stopAllCalls = 0
    var detachCalls = 0
    var openedUrls: [String] = []
    var standaloneLaunches: [String] = []
    var isLeaderReadyCalls = 0

    override func stopAll() {
        stopAllCalls += 1
    }

    @discardableResult
    override func detachAll() -> [PersistedLaunchRecord] {
        detachCalls += 1
        return []
    }

    override func launchStandalone(_ target: AppTarget) throws {
        standaloneLaunches.append(target.name)
    }

    override func isLeaderReady() -> Bool {
        isLeaderReadyCalls += 1
        return false
    }
}
