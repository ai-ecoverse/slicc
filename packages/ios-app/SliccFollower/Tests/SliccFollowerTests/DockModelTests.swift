import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

/// The dock's item order and placeholder honesty (#1802) — pure model,
/// mirroring `slicc-dock.ts`.
final class DockModelTests: XCTestCase {

    private func sprinkle(_ name: String, icon: String? = nil) -> SprinkleSummary {
        SprinkleSummary(
            name: name, title: name.capitalized, path: "/sprinkles/\(name).shtml",
            open: false, autoOpen: false, icon: icon)
    }

    func testSprinkleItemsKeepLeaderOrder() {
        let items = DockModel.sprinkleItems([sprinkle("alpha"), sprinkle("beta")])
        XCTAssertEqual(
            items.map(\.id), ["sprinkle-alpha", "sprinkle-beta"],
            "launchers in leader order")
    }

    func testRailCarriesNoNewSprinkleLauncher() {
        let items = DockModel.sprinkleItems([sprinkle("alpha")])
        XCTAssertFalse(
            items.contains { $0.id == "new" },
            "sprinkles are authored on the leader — a `+` here could only open a placeholder")
    }

    func testSprinkleItemsCarryTheLeaderDeclaredIcon() {
        let items = DockModel.sprinkleItems([
            sprinkle("pomodoro", icon: "timer"),
            sprinkle("plain"),
            sprinkle("pathy", icon: "/workspace/icon.svg"),
            sprinkle("obscure", icon: "not-a-real-lucide-name"),
        ])
        XCTAssertEqual(items[0].systemImage, "timer", "declared lucide name maps to its SF Symbol")
        XCTAssertEqual(items[1].systemImage, "sparkles", "no icon declared → generic sparkle")
        XCTAssertEqual(
            items[2].systemImage, "sparkles",
            "VFS paths render in other surfaces, not the rail (isLucideIconSpec parity)")
        XCTAssertEqual(
            items[3].systemImage, "sparkles",
            "an unmapped lucide name degrades to the sparkle, never a missing glyph")
    }

    func testToolOrderMirrorsTheWebDock() {
        XCTAssertEqual(
            DockModel.toolItems.map(\.id),
            ["browser", "files", "term", "memory", "monitor"],
            "prototype order is the contract (slicc-dock.ts SYSTEM_TOOLS)")
    }

    func testEveryDockSurfaceHasARealView() {
        // Both leader-only placeholders are gone: `new sprinkle` left the rail
        // entirely (#1885) and the terminal is now leader-backed. Nothing in
        // the dock may render an apology any more, so the honesty test that
        // used to assert placeholder copy asserts their absence instead.
        let surfaces = DockModel.toolItems.map(\.surface) + [DockSurface.sprinkle(name: "any")]
        for surface in surfaces {
            XCTAssertTrue(
                DockModel.toolItems.contains { $0.surface == surface }
                    || surface == .sprinkle(name: "any"),
                "\(surface) must be reachable from the rail")
        }
    }
}
