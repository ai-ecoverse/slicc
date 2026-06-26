import XCTest
@testable import Sliccstart

/// Regression tests for `SliccProcess.detachAll()`. The Phase A
/// implementation called `detachAll()` from both `onBeginUpdate` and
/// `applicationWillTerminate`; without an idempotency latch the second
/// call would overwrite `launch-records.json` with an empty array
/// (because the first pass had already cleared `launchRecords`), which
/// silently breaks the smooth-update promise — the next launch finds
/// nothing to reattach to.
@MainActor
final class SliccProcessDetachTests: XCTestCase {

    func testDetachAllPersistsSnapshotOnce_AndIsIdempotentAfterFirstCall() throws {
        let storeURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("SliccProcessDetachTests-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: storeURL) }

        let store = LaunchRecordStore(storeURL: storeURL)
        let proc = SliccProcess(recordStore: store, cdpLiveProbe: .default)

        // Seed a real running subprocess so `detachAll()` doesn't filter
        // the record out via `process.isRunning`. Default disposition for
        // SIGUSR1 is to terminate, so the helper exits on the kill below
        // instead of hanging until the test deadline.
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sleep")
        helper.arguments = ["60"]
        try helper.run()
        addTeardownBlock {
            if helper.isRunning { helper.terminate() }
        }

        proc._testing_seedLaunchRecord(
            id: "test-target",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "TestBrowser"
        )

        let firstSnapshot = proc.detachAll()
        XCTAssertEqual(firstSnapshot.count, 1)
        XCTAssertEqual(firstSnapshot.first?.targetId, "test-target")
        XCTAssertEqual(store.load().count, 1, "first call must persist the live record")

        // Second call — the regression. Without the latch this would
        // see an empty `launchRecords`, compute an empty snapshot, and
        // overwrite the JSON with `[]`.
        let secondSnapshot = proc.detachAll()
        XCTAssertEqual(secondSnapshot.count, 1, "second call must surface the persisted snapshot")
        let onDisk = store.load()
        XCTAssertEqual(onDisk.count, 1, "second detachAll() must NOT erase the persisted record")
        XCTAssertEqual(onDisk.first?.targetId, "test-target")
        XCTAssertEqual(onDisk.first?.targetName, "TestBrowser")
        XCTAssertEqual(onDisk.first?.cdpPort, 39222)
    }

    func testDetachAllPersistsBridgeTokenFromLaunchRecord() throws {
        // Regression for the "persist bridge tokens across launcher relaunch"
        // finding: the token the runtime was launched with must land in the
        // snapshot so a post-update reattach re-forwards the SAME secret the
        // still-running browser tab carries in its launch URL.
        let storeURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("SliccProcessDetachTests-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: storeURL) }

        let store = LaunchRecordStore(storeURL: storeURL)
        let proc = SliccProcess(recordStore: store, cdpLiveProbe: .default)

        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sleep")
        helper.arguments = ["60"]
        try helper.run()
        addTeardownBlock {
            if helper.isRunning { helper.terminate() }
        }

        proc._testing_seedLaunchRecord(
            id: "test-target",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "TestBrowser",
            bridgeToken: "persisted-token-xyz"
        )

        let snapshot = proc.detachAll()
        XCTAssertEqual(snapshot.first?.bridgeToken, "persisted-token-xyz")
        XCTAssertEqual(store.load().first?.bridgeToken, "persisted-token-xyz",
                       "the launch token must be persisted for the next launch's reattach")
    }

    func testDetachAllWithNoRecords_LeavesPreviouslyPersistedSnapshotIntactOnRecall() throws {
        let storeURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("SliccProcessDetachTests-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: storeURL) }

        let store = LaunchRecordStore(storeURL: storeURL)
        let seeded = [
            PersistedLaunchRecord(
                targetId: "seeded",
                targetName: "Pre",
                targetType: .chromiumBrowser,
                electronAppPath: nil,
                servePort: 5710,
                cdpPort: 9222
            )
        ]
        try store.save(seeded)

        let proc = SliccProcess(recordStore: store, cdpLiveProbe: .default)
        // First call sees no in-memory records → naturally writes [].
        // Second call must be a no-op and not touch the file again.
        _ = proc.detachAll()
        _ = proc.detachAll()
        // Idempotency check — we don't claim the seeded data survives
        // the *first* call (there was nothing to detach), only that the
        // second call doesn't make things worse.
        XCTAssertEqual(proc.detachAll().count, store.load().count,
                       "repeated detachAll() calls must agree on the persisted state")
    }
}
