import Foundation
import XCTest

@testable import SliccWidgetKit

final class WidgetSnapshotStoreTests: XCTestCase {
    func testRoundTripsThroughJSON() throws {
        let original = WidgetSnapshot.fixtureBusy
        let decoded = try WidgetSnapshotStore.decode(WidgetSnapshotStore.encode(original))
        XCTAssertEqual(decoded, original)
    }

    func testRejectsAFutureSchema() throws {
        var json =
            try JSONSerialization.jsonObject(
                with: WidgetSnapshotStore.encode(.fixtureBusy)) as? [String: Any] ?? [:]
        json["schema"] = WidgetSnapshot.currentSchema + 1
        let data = try JSONSerialization.data(withJSONObject: json)
        XCTAssertThrowsError(try WidgetSnapshotStore.decode(data)) { error in
            XCTAssertEqual(
                error as? WidgetSnapshotStoreError,
                .futureSchema(WidgetSnapshot.currentSchema + 1))
        }
    }

    
    
    func testUnknownEnumValuesDegradeTheUnitRatherThanTheSnapshot() throws {
        let json = """
            {
              "schema": 1,
              "instanceLabel": "x",
              "connection": "connected",
              "capturedAt": "2026-08-27T10:00:00Z",
              "units": [
                {"id": "a", "name": "A", "role": "cone", "lifecycle": "hibernating", "activity": "vibing"}
              ]
            }
            """
        let snapshot = try WidgetSnapshotStore.decode(Data(json.utf8))
        XCTAssertEqual(snapshot.units.first?.lifecycle, .unknown)
        XCTAssertNil(snapshot.units.first?.activity)
        XCTAssertEqual(snapshot.connection, .connected)
    }

    func testAMissingConnectionReadsAsNoInstance() throws {
        let snapshot = try WidgetSnapshotStore.decode(Data("{}".utf8))
        XCTAssertEqual(snapshot.connection, .none)
        XCTAssertTrue(snapshot.isUnavailable)
    }

    func testWriteWithoutAnEntitledContainerReportsIt() {
        let store = WidgetSnapshotStore(appGroup: "group.invalid.not.entitled") { _ in nil }
        XCTAssertNil(store.url)
        XCTAssertNil(store.read())
        XCTAssertThrowsError(try store.write(.fixtureBusy)) { error in
            XCTAssertEqual(
                error as? WidgetSnapshotStoreError, .noContainer("group.invalid.not.entitled"))
        }
    }

    
    
    func testTheSnapshotLivesSomewhereADeviceCanBeAskedAbout() {
        let store = WidgetSnapshotStore(appGroup: "g") { _ in URL(fileURLWithPath: "/tmp/c") }
        XCTAssertEqual(store.url?.path, "/tmp/c/Library/widget-snapshot.json")
    }

    func testWriteThenReadIsTheWholeContract() throws {
        let container = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("slicc-widget-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: container) }

        let store = WidgetSnapshotStore(appGroup: "test") { _ in container }
        XCTAssertNil(store.read(), "nothing written yet")
        try store.write(.fixtureBusy)
        XCTAssertEqual(store.read(), .fixtureBusy)

        
        
        try store.write(.fixtureAwaiting)
        XCTAssertEqual(store.read(), .fixtureAwaiting)

        store.clear()
        XCTAssertNil(store.read(), "a detached instance must not linger on a home screen")
    }

    func testGarbageOnDiskReadsAsNoSnapshotRatherThanACrash() throws {
        let container = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("slicc-widget-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: container) }
        let library = container.appendingPathComponent(WidgetSnapshotStore.subdirectory)
        try FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: library.appendingPathComponent("widget-snapshot.json"))

        XCTAssertNil(WidgetSnapshotStore(appGroup: "test") { _ in container }.read())
    }

    
    
    
    func testTheCrowdedSnapshotStaysSmall() throws {
        let data = try WidgetSnapshotStore.encode(.fixtureCrowded)
        XCTAssertLessThan(data.count, 4096)
    }
}
