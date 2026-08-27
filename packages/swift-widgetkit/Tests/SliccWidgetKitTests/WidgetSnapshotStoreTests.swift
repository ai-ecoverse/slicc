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

    /// A leader that learns a fifth lifecycle must cost one unit's detail, not
    /// the whole widget.
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

    func testWriteThenReadIsTheWholeContract() throws {
        let container = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("slicc-widget-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: container) }

        let store = WidgetSnapshotStore(appGroup: "test") { _ in container }
        XCTAssertNil(store.read(), "nothing written yet")
        try store.write(.fixtureBusy)
        XCTAssertEqual(store.read(), .fixtureBusy)

        // A second write replaces rather than appends — the widget must never
        // see two snapshots concatenated.
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
        try Data("not json".utf8).write(to: container.appendingPathComponent("widget-snapshot.json"))

        XCTAssertNil(WidgetSnapshotStore(appGroup: "test") { _ in container }.read())
    }

    /// The snapshot is small enough to write from a `scoops.list` handler
    /// without thinking about it. If this ever fails, the capture side is
    /// putting something in it that does not belong on a home screen.
    func testTheCrowdedSnapshotStaysSmall() throws {
        let data = try WidgetSnapshotStore.encode(.fixtureCrowded)
        XCTAssertLessThan(data.count, 4096)
    }
}
