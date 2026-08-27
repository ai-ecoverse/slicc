import Foundation
import XCTest

@testable import SliccWidgetKit

@MainActor
final class WidgetSnapshotPublisherTests: XCTestCase {
    private var container: URL!
    private var store: WidgetSnapshotStore!
    private var now = Date(timeIntervalSince1970: 1_787_000_000)
    private var reloads = 0

    override func setUp() async throws {
        container = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("widget-publisher-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        store = WidgetSnapshotStore(appGroup: "test") { [container] _ in container }
        reloads = 0
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: container)
    }

    private func makePublisher(interval: TimeInterval = 15) -> WidgetSnapshotPublisher {
        WidgetSnapshotPublisher(
            store: store, minimumInterval: interval, clock: { [unowned self] in now },
            reload: { [unowned self] in reloads += 1 })
    }

    private func snapshot(
        units: [WidgetUnit] = [], connection: WidgetSnapshot.Connection = .connected,
        label: String = "x"
    ) -> WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: label, connection: connection, capturedAt: now, units: units)
    }

    private func unit(
        _ id: String, _ lifecycle: WidgetUnit.Lifecycle = .working,
        activity: WidgetUnit.Activity? = nil
    ) -> WidgetUnit {
        WidgetUnit(id: id, name: id, role: .cone, lifecycle: lifecycle, activity: activity)
    }

    func testTheFirstSnapshotIsWrittenImmediately() {
        let publisher = makePublisher()
        publisher.publish(snapshot(label: "first"))

        XCTAssertEqual(store.read()?.instanceLabel, "first")
        XCTAssertEqual(reloads, 1, "the widget is reloaded exactly once per write")
    }

    /// `scoops.list` arrives on every turn boundary and every tool bracket. A
    /// reload per arrival spends WidgetKit's daily budget by mid-morning and
    /// then leaves the tile frozen at the moment that mattered.
    func testARoutineBurstIsCoalesced() {
        let publisher = makePublisher()
        publisher.publish(snapshot(units: [unit("a")], label: "first"))
        XCTAssertEqual(reloads, 1)

        now = now.addingTimeInterval(1)
        publisher.publish(snapshot(units: [unit("a")], label: "second"))
        now = now.addingTimeInterval(1)
        publisher.publish(snapshot(units: [unit("a")], label: "third"))

        XCTAssertEqual(store.read()?.instanceLabel, "first", "held back")
        XCTAssertEqual(reloads, 1)
    }

    /// The last state in a burst must not be the one that gets dropped.
    func testTheHeldSnapshotIsTheOneThatEventuallyLands() {
        let publisher = makePublisher()
        publisher.publish(snapshot(units: [unit("a")], label: "first"))
        now = now.addingTimeInterval(1)
        publisher.publish(snapshot(units: [unit("a")], label: "second"))
        now = now.addingTimeInterval(1)
        publisher.publish(snapshot(units: [unit("a")], label: "third"))

        now = now.addingTimeInterval(20)
        publisher._testing_flushPending()

        XCTAssertEqual(store.read()?.instanceLabel, "third")
        XCTAssertEqual(reloads, 2)
    }

    func testTheRateLimitOpensAgainAfterTheInterval() {
        let publisher = makePublisher(interval: 15)
        publisher.publish(snapshot(units: [unit("a")], label: "first"))
        now = now.addingTimeInterval(16)
        publisher.publish(snapshot(units: [unit("a")], label: "later"))

        XCTAssertEqual(store.read()?.instanceLabel, "later")
        XCTAssertEqual(reloads, 2)
    }

    // MARK: Urgency

    /// Something breaking, a turn handing back, the unit list changing shape,
    /// or the link dying all bypass the rate limit — they are rare by nature,
    /// which is exactly why they can afford to.
    func testUrgentTransitionsBypassTheRateLimit() {
        let base = snapshot(units: [unit("a")])
        let cases: [(String, WidgetSnapshot)] = [
            ("broke", snapshot(units: [unit("a", .broken)])),
            ("handed back", snapshot(units: [unit("a", .idle, activity: .awaiting)])),
            ("gained a unit", snapshot(units: [unit("a"), unit("b")])),
            ("link died", snapshot(units: [unit("a")], connection: .disconnected)),
        ]
        for (label, next) in cases {
            XCTAssertTrue(
                WidgetSnapshotPublisher.isUrgent(next, comparedTo: base), "\(label) must be urgent")
        }
        XCTAssertFalse(
            WidgetSnapshotPublisher.isUrgent(snapshot(units: [unit("a")]), comparedTo: base),
            "the same shape is not urgent")
        XCTAssertTrue(
            WidgetSnapshotPublisher.isUrgent(base, comparedTo: nil), "the first one always lands")
    }

    func testAnUrgentSnapshotWritesEvenInsideTheWindow() {
        let publisher = makePublisher()
        publisher.publish(snapshot(units: [unit("a")], label: "first"))
        now = now.addingTimeInterval(1)
        publisher.publish(snapshot(units: [unit("a", .broken)], label: "broke"))

        XCTAssertEqual(store.read()?.instanceLabel, "broke")
        XCTAssertEqual(reloads, 2)
    }

    // MARK: Clearing

    /// A detached session must not keep naming itself on a home screen.
    func testClearingRemovesTheSnapshotAndReloads() {
        let publisher = makePublisher()
        publisher.publish(snapshot(label: "gone"))
        publisher.clear()

        XCTAssertNil(store.read())
        XCTAssertEqual(reloads, 2)
    }

    func testClearingDropsAHeldSnapshotToo() {
        let publisher = makePublisher()
        publisher.publish(snapshot(units: [unit("a")], label: "first"))
        now = now.addingTimeInterval(1)
        publisher.publish(snapshot(units: [unit("a")], label: "held"))
        publisher.clear()
        publisher._testing_flushPending()

        XCTAssertNil(store.read(), "a held snapshot must not resurrect a forgotten instance")
    }

    /// An unsigned dev or simulator build has no group container. That is the
    /// normal case there, not an error path.
    func testAMissingContainerIsSurvivable() {
        let publisher = WidgetSnapshotPublisher(
            store: WidgetSnapshotStore(appGroup: "missing") { _ in nil },
            clock: { [unowned self] in now }, reload: { [unowned self] in reloads += 1 })

        publisher.publish(snapshot())

        XCTAssertEqual(reloads, 0, "nothing was written, so nothing is reloaded")
    }
}
