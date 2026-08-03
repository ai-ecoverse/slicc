import XCTest

/// The dock rail + workbench overlay (#1802): tap-idle selects, tap-active
/// collapses, and leader-only surfaces render their honest placeholder.
final class DockUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testDockShowsDisconnectedTerminalState() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", "disconnected"]
        app.launch()

        let term = app.buttons["dock-term"]
        XCTAssertTrue(term.waitForExistence(timeout: 60))
        term.tap()

        let placeholder = app.staticTexts["terminal-disconnected"]
        XCTAssertTrue(
            placeholder.waitForExistence(timeout: 10),
            "the terminal surface asks for an active leader")

        // Tapping the ACTIVE item collapses the workbench — a toggle, not a
        // nav stack (web dock parity).
        term.tap()
        XCTAssertFalse(
            placeholder.waitForExistence(timeout: 3),
            "tap-active collapses back to chat")
    }

    func testNewChatLivesInTheTopControlNotTheRail() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", "connected"]
        app.launch()

        let newChat = app.buttons["new-chat-button"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 60))
        XCTAssertFalse(
            app.buttons["dock-freezer"].exists,
            "the rail belongs to sprinkles and tools — session actions live up top")
        newChat.tap()

        XCTAssertTrue(
            app.buttons["Save & start new"].waitForExistence(timeout: 10),
            "the top-control New chat opens the shared disposition dialog")
    }

    func testLeftHandedDockKeepsTheRailUsable() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-leftHandedDock", "YES",
            "-uiTestTerminalFixture", "YES",
        ]
        app.launch()

        let term = app.buttons["dock-term"]
        XCTAssertTrue(term.waitForExistence(timeout: 60))
        term.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["terminal-surface"].waitForExistence(timeout: 10),
            "the mirrored rail toggles surfaces exactly like the trailing one")
    }
}
