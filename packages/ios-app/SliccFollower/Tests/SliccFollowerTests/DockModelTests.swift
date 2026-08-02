import XCTest

@testable import SliccFollower

/// The dock's item order and placeholder honesty (#1802) — pure model,
/// mirroring `slicc-dock.ts`.
final class DockModelTests: XCTestCase {

    private func sprinkle(_ name: String) -> SprinkleSummary {
        SprinkleSummary(
            name: name, title: name.capitalized, path: "/sprinkles/\(name).shtml",
            open: false, autoOpen: false, icon: nil)
    }

    func testSprinkleItemsKeepLeaderOrderAndEndWithNew() {
        let items = DockModel.sprinkleItems([sprinkle("alpha"), sprinkle("beta")])
        XCTAssertEqual(
            items.map(\.id), ["sprinkle-alpha", "sprinkle-beta", "new"],
            "launchers in leader order, New + always last")
        XCTAssertEqual(items.last?.surface, .newSprinkle)
    }

    func testToolOrderMirrorsTheWebDock() {
        XCTAssertEqual(
            DockModel.toolItems.map(\.id),
            ["browser", "files", "term", "memory", "monitor"],
            "prototype order is the contract (slicc-dock.ts SYSTEM_TOOLS)")
    }

    func testLeaderOnlySurfacesExplainThemselves() {
        for surface in [DockSurface.term, .newSprinkle] {
            XCTAssertNotNil(
                DockModel.placeholderText(for: surface),
                "\(surface) has no native view — it must say why, not render empty")
        }
        // Real views carry no placeholder: browser, sprinkles, monitor (#1868).
        XCTAssertNil(DockModel.placeholderText(for: .browser))
        XCTAssertNil(DockModel.placeholderText(for: .sprinkle(name: "x")))
        XCTAssertNil(DockModel.placeholderText(for: .monitor))
        XCTAssertNil(DockModel.placeholderText(for: .memory))
        XCTAssertNil(DockModel.placeholderText(for: .files))
    }
}
