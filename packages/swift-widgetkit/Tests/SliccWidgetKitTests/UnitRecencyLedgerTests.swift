import Foundation
import XCTest

@testable import SliccWidgetKit

/// The widget orders by recency and the wire carries no timestamp, so this is
/// where "recent" is defined at all.
final class UnitRecencyLedgerTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_787_000_000)

    private func unit(
        _ id: String, _ lifecycle: WidgetUnit.Lifecycle = .idle,
        activity: WidgetUnit.Activity? = nil, fill: Double? = nil, name: String = "n"
    ) -> WidgetUnit {
        WidgetUnit(id: id, name: name, role: .scoop, lifecycle: lifecycle, activity: activity, fill: fill)
    }

    func testAUnitSeenForTheFirstTimeIsStampedNow() {
        var ledger = UnitRecencyLedger()
        let stamped = ledger.stamp([unit("a")], now: t0)
        XCTAssertEqual(stamped.first?.lastActivityAt, t0)
    }

    /// The whole point: a unit that has not moved keeps the stamp it earned,
    /// so it sinks in the order as others move.
    func testAnUnchangedUnitKeepsItsOriginalStamp() {
        var ledger = UnitRecencyLedger()
        _ = ledger.stamp([unit("a")], now: t0)
        let later = ledger.stamp([unit("a")], now: t0.addingTimeInterval(600))
        XCTAssertEqual(later.first?.lastActivityAt, t0)
    }

    func testEveryObservableChangeRestampsTheUnit() {
        let changes: [(String, WidgetUnit)] = [
            ("lifecycle", unit("a", .working)),
            ("activity", unit("a", .idle, activity: .awaiting)),
            ("fill", unit("a", .idle, fill: 40)),
        ]
        for (label, changed) in changes {
            var ledger = UnitRecencyLedger()
            _ = ledger.stamp([unit("a")], now: t0)
            let later = ledger.stamp([changed], now: t0.addingTimeInterval(60))
            XCTAssertEqual(
                later.first?.lastActivityAt, t0.addingTimeInterval(60), "\(label) did not restamp")
        }
    }

    /// A rename is not activity. Neither is a model swap — that is a setting.
    func testARenameIsNotActivity() {
        var ledger = UnitRecencyLedger()
        _ = ledger.stamp([unit("a", name: "before")], now: t0)
        let later = ledger.stamp([unit("a", name: "after")], now: t0.addingTimeInterval(60))
        XCTAssertEqual(later.first?.lastActivityAt, t0)
    }

    /// Fill is watched at whole-percent resolution, so a context window
    /// creeping by fractions does not count as a fresh event every refresh.
    func testSubPercentFillDriftDoesNotRestamp() {
        var ledger = UnitRecencyLedger()
        _ = ledger.stamp([unit("a", fill: 40.2)], now: t0)
        let later = ledger.stamp([unit("a", fill: 40.7)], now: t0.addingTimeInterval(60))
        XCTAssertEqual(later.first?.lastActivityAt, t0)
    }

    /// A scoop that leaves and comes back is new again — it must not inherit a
    /// position in the order that it did not earn.
    func testAUnitThatLeavesIsForgotten() {
        var ledger = UnitRecencyLedger()
        _ = ledger.stamp([unit("a"), unit("b")], now: t0)
        _ = ledger.stamp([unit("b")], now: t0.addingTimeInterval(60))
        let back = ledger.stamp([unit("a"), unit("b")], now: t0.addingTimeInterval(120))
        XCTAssertEqual(back.first(where: { $0.id == "a" })?.lastActivityAt, t0.addingTimeInterval(120))
        XCTAssertEqual(back.first(where: { $0.id == "b" })?.lastActivityAt, t0)
    }

    func testStampingPreservesEverythingElseAboutTheUnit() {
        var ledger = UnitRecencyLedger()
        let original = WidgetUnit(
            id: "a", name: "boy-scout", role: .scoop, parentId: "cone", lifecycle: .working,
            activity: .tool, fill: 42, model: "opus", detail: "d", isActive: true)
        let stamped = ledger.stamp([original], now: t0).first
        XCTAssertEqual(stamped, original.stamped(lastActivityAt: t0))
        XCTAssertEqual(stamped?.parentId, "cone")
        XCTAssertEqual(stamped?.model, "opus")
        XCTAssertEqual(stamped?.detail, "d")
        XCTAssertTrue(stamped?.isActive ?? false)
    }

    func testAnEmptySessionIsSurvivable() {
        var ledger = UnitRecencyLedger()
        _ = ledger.stamp([unit("a")], now: t0)
        XCTAssertTrue(ledger.stamp([], now: t0.addingTimeInterval(60)).isEmpty)
    }
}
