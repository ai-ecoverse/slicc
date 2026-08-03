import XCTest

@testable import SliccFollower

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

    func testLeaderOnlySurfacesExplainThemselves() {
        XCTAssertNotNil(
            DockModel.placeholderText(for: .term),
            "the terminal has no native view — it must say why, not render empty")
        // Real views carry no placeholder: browser, sprinkles, monitor (#1868).
        XCTAssertNil(DockModel.placeholderText(for: .browser))
        XCTAssertNil(DockModel.placeholderText(for: .sprinkle(name: "x")))
        XCTAssertNil(DockModel.placeholderText(for: .monitor))
        XCTAssertNil(DockModel.placeholderText(for: .memory))
        XCTAssertNil(DockModel.placeholderText(for: .files))
    }
}
