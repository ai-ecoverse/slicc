import XCTest
@testable import Sliccstart

final class LaunchRecordStoreTests: XCTestCase {
    private var tempDir: URL!
    private var storeURL: URL!
    private var store: LaunchRecordStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("LaunchRecordStoreTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        storeURL = tempDir.appendingPathComponent("launch-records.json")
        store = LaunchRecordStore(storeURL: storeURL)
    }

    override func tearDownWithError() throws {
        if let tempDir, FileManager.default.fileExists(atPath: tempDir.path) {
            try? FileManager.default.removeItem(at: tempDir)
        }
        try super.tearDownWithError()
    }

    func testLoadReturnsEmptyArrayWhenFileMissing() {
        XCTAssertEqual(store.load(), [])
    }

    func testSaveAndLoadRoundTrip() throws {
        let records: [PersistedLaunchRecord] = [
            PersistedLaunchRecord(
                targetId: "/Applications/Google Chrome.app",
                targetName: "Google Chrome",
                targetType: .chromiumBrowser,
                electronAppPath: nil,
                servePort: 5710,
                cdpPort: 9222,
                staticRoot: nil,
                joinUrl: nil
            ),
            PersistedLaunchRecord(
                targetId: "/Applications/Slack.app",
                targetName: "Slack",
                targetType: .electronApp,
                electronAppPath: "/Applications/Slack.app",
                servePort: 5711,
                cdpPort: 9223,
                staticRoot: "/tmp/ui-overlays/2.55.0",
                joinUrl: "https://www.sliccy.ai/join/abc.def"
            ),
        ]

        try store.save(records)
        XCTAssertTrue(FileManager.default.fileExists(atPath: storeURL.path))
        XCTAssertEqual(store.load(), records)
    }

    func testDecodeLegacyJSONWithoutJoinUrlFieldDefaultsToNil() throws {
        // JSON written by older Sliccstart versions does not carry the
        // `joinUrl` key. Persisted records must continue to load with
        // `joinUrl == nil` instead of failing the whole snapshot.
        let legacyJSON = """
        [
          {
            "targetId": "/Applications/Slack.app",
            "targetName": "Slack",
            "targetType": "electronApp",
            "electronAppPath": "/Applications/Slack.app",
            "servePort": 5711,
            "cdpPort": 9223,
            "staticRoot": null
          }
        ]
        """
        try legacyJSON.write(to: storeURL, atomically: true, encoding: .utf8)

        let loaded = store.load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.targetName, "Slack")
        XCTAssertNil(loaded.first?.joinUrl)
    }

    func testClearRemovesFile() throws {
        try store.save([
            PersistedLaunchRecord(
                targetId: "x",
                targetName: "x",
                targetType: .chromiumBrowser,
                electronAppPath: nil,
                servePort: 5710,
                cdpPort: 9222,
                staticRoot: nil
            )
        ])
        XCTAssertTrue(FileManager.default.fileExists(atPath: storeURL.path))
        store.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: storeURL.path))
        XCTAssertEqual(store.load(), [])
    }

    func testLoadReturnsEmptyOnCorruptJSON() throws {
        try "not json".write(to: storeURL, atomically: true, encoding: .utf8)
        XCTAssertEqual(store.load(), [], "corrupt files must not crash the launcher")
    }

    func testSaveCreatesParentDirectory() throws {
        let nested = tempDir
            .appendingPathComponent("deep", isDirectory: true)
            .appendingPathComponent("nested", isDirectory: true)
            .appendingPathComponent("records.json")
        let nestedStore = LaunchRecordStore(storeURL: nested)
        try nestedStore.save([
            PersistedLaunchRecord(
                targetId: "x",
                targetName: "x",
                targetType: .chromiumBrowser,
                electronAppPath: nil,
                servePort: 5710,
                cdpPort: 9222,
                staticRoot: nil
            )
        ])
        XCTAssertTrue(FileManager.default.fileExists(atPath: nested.path))
    }
}

final class CDPLiveProbeTests: XCTestCase {
    func testIsAliveReturnsTrueOn200() async {
        let probe = CDPLiveProbe(fetch: { _ in 200 })
        let alive = await probe.isAlive(cdpPort: 9222)
        XCTAssertTrue(alive)
    }

    func testIsAliveReturnsFalseOnNon2xx() async {
        let probe = CDPLiveProbe(fetch: { _ in 500 })
        let alive = await probe.isAlive(cdpPort: 9222)
        XCTAssertFalse(alive)
    }

    func testIsAliveReturnsFalseOnThrow() async {
        let probe = CDPLiveProbe(fetch: { _ in throw URLError(.cannotConnectToHost) })
        let alive = await probe.isAlive(cdpPort: 9222)
        XCTAssertFalse(alive)
    }

    func testIsAliveProbesTheRightURL() async {
        let captured = URLBox()
        let probe = CDPLiveProbe(fetch: { url in
            await captured.set(url)
            return 200
        })
        _ = await probe.isAlive(cdpPort: 9876)
        let url = await captured.get()
        XCTAssertEqual(url?.absoluteString, "http://127.0.0.1:9876/json/version")
    }
}

private actor URLBox {
    private var url: URL?
    func set(_ url: URL) { self.url = url }
    func get() -> URL? { url }
}
