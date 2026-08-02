import XCTest

/// The dock rail + workbench overlay (#1802): tap-idle selects, tap-active
/// collapses, and leader-only surfaces render their honest placeholder.
final class DockUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testDockTogglesTheTerminalPlaceholder() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", "connected"]
        app.launch()

        let term = app.buttons["dock-term"]
        XCTAssertTrue(term.waitForExistence(timeout: 60))
        term.tap()

        let placeholder = app.staticTexts["workbench-placeholder"]
        XCTAssertTrue(
            placeholder.waitForExistence(timeout: 10),
            "the terminal surface explains it lives on the leader")

        // Tapping the ACTIVE item collapses the workbench — a toggle, not a
        // nav stack (web dock parity).
        term.tap()
        XCTAssertFalse(
            placeholder.waitForExistence(timeout: 3),
            "tap-active collapses back to chat")
    }

    func testDockFreezerOpensPastSessions() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestFrozenFixture", "YES",
        ]
        app.launch()

        let freezer = app.buttons["dock-freezer"]
        XCTAssertTrue(freezer.waitForExistence(timeout: 60))
        freezer.tap()

        XCTAssertTrue(
            app.staticTexts["Fix the build"].waitForExistence(timeout: 10),
            "the dock's leading-edge freezer opens the Past Sessions sheet")
    }
}
