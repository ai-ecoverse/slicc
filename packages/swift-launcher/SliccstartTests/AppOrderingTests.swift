import AppKit
import XCTest

@testable import Sliccstart

/// Ordering rules for the Browsers and Terminals lists: default priority,
/// saved user overrides, and the drag-reorder persistence helper.
final class AppOrderingTests: XCTestCase {

    private func target(_ name: String, _ bundleId: String?, _ type: AppTargetType) -> AppTarget {
        let path = "/Applications/\(name).app"
        return AppTarget(
            id: path,
            name: name,
            path: path,
            executablePath: "\(path)/Contents/MacOS/\(name)",
            type: type,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported,
            isDebugBuild: false,
            originalAppPath: nil,
            bundleId: bundleId
        )
    }

    private func browser(_ name: String, _ bundleId: String?) -> AppTarget {
        target(name, bundleId, .chromiumBrowser)
    }

    private func terminal(_ name: String, _ bundleId: String?) -> AppTarget {
        target(name, bundleId, .terminal)
    }

    func testBrowsersOrderByMarketSharePriorityByDefault() {
        let targets = [
            browser("Brave", "com.brave.Browser"),
            browser("Chrome", "com.google.Chrome"),
            browser("Edge", "com.microsoft.edgemac"),
        ]
        let ordered = AppOrdering.ordered(
            targets,
            savedOrder: [],
            defaultPriority: AppOrdering.browserBundlePriority
        )
        XCTAssertEqual(ordered.map(\.name), ["Chrome", "Edge", "Brave"])
    }

    func testTerminalsPreferPowerUserAppOverTerminalApp() {
        let targets = [
            terminal("Terminal", "com.apple.Terminal"),
            terminal("Alacritty", "org.alacritty"),
        ]
        let ordered = AppOrdering.ordered(
            targets,
            savedOrder: [],
            defaultPriority: AppOrdering.terminalBundlePriority
        )
        XCTAssertEqual(ordered.map(\.name), ["Alacritty", "Terminal"])
    }

    func testSavedOrderWinsOverDefaultPriority() {
        let targets = [
            browser("Chrome", "com.google.Chrome"),
            browser("Brave", "com.brave.Browser"),
        ]
        let ordered = AppOrdering.ordered(
            targets,
            savedOrder: ["com.brave.Browser", "com.google.Chrome"],
            defaultPriority: AppOrdering.browserBundlePriority
        )
        XCTAssertEqual(ordered.map(\.name), ["Brave", "Chrome"])
    }

    func testUnknownBundleIdsSortAlphabeticallyAfterKnown() {
        let targets = [
            browser("Zeta", "com.example.zeta"),
            browser("Chrome", "com.google.Chrome"),
            browser("Alpha", "com.example.alpha"),
        ]
        let ordered = AppOrdering.ordered(
            targets,
            savedOrder: [],
            defaultPriority: AppOrdering.browserBundlePriority
        )
        XCTAssertEqual(ordered.map(\.name), ["Chrome", "Alpha", "Zeta"])
    }

    func testTopBrowserIgnoresNonBrowserTargetsAndHonoursSavedOrder() {
        // Both the startup auto-launch and the default-browser link handler
        // resolve "the" leader through this helper, so they can never
        // disagree about which browser to start.
        let targets = [
            terminal("Alacritty", "org.alacritty"),
            browser("Chrome", "com.google.Chrome"),
            browser("Brave", "com.brave.Browser"),
        ]

        XCTAssertEqual(AppOrdering.topBrowser(in: targets, savedOrder: [])?.name, "Chrome")
        XCTAssertEqual(
            AppOrdering.topBrowser(in: targets, savedOrder: ["com.brave.Browser"])?.name,
            "Brave"
        )
        XCTAssertNil(AppOrdering.topBrowser(in: [terminal("Terminal", "com.apple.Terminal")], savedOrder: []))
    }

    func testPersistableOrderSkipsTargetsWithoutBundleId() {
        let reordered = [
            browser("Chrome", "com.google.Chrome"),
            browser("Mystery", nil),
            browser("Brave", "com.brave.Browser"),
        ]
        XCTAssertEqual(
            AppOrdering.persistableOrder(from: reordered),
            ["com.google.Chrome", "com.brave.Browser"]
        )
    }

    func testReorderMovesItemDown() {
        XCTAssertEqual(
            AppOrdering.reorder(["a", "b", "c"], moving: "a", over: "c"),
            ["b", "c", "a"]
        )
    }

    func testReorderMovesItemUp() {
        XCTAssertEqual(
            AppOrdering.reorder(["a", "b", "c"], moving: "c", over: "a"),
            ["c", "a", "b"]
        )
    }

    func testReorderIsNoOpWhenIdsMatchOrAbsent() {
        XCTAssertEqual(AppOrdering.reorder(["a", "b"], moving: "a", over: "a"), ["a", "b"])
        XCTAssertEqual(AppOrdering.reorder(["a", "b"], moving: "z", over: "a"), ["a", "b"])
        XCTAssertEqual(AppOrdering.reorder(["a", "b"], moving: "a", over: "z"), ["a", "b"])
    }

    func testBrowserLaunchActionResolves() {
        XCTAssertEqual(
            BrowserLaunchAction.resolve(isRunning: false, hasRemoteSessions: true),
            .chooseLeadOrAttach
        )
        XCTAssertEqual(
            BrowserLaunchAction.resolve(isRunning: true, hasRemoteSessions: true),
            .standalone
        )
        XCTAssertEqual(
            BrowserLaunchAction.resolve(isRunning: false, hasRemoteSessions: false),
            .standalone
        )
    }
}
