import XCTest

/// The Past Sessions sheet's New button: three clearly labeled dispositions,
/// with erase double-confirming before anything fires. Driven leaderless via
/// the frozen fixture + `-uiTestOpenNewSession`.
final class NewSessionUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testDialogOffersThreeActionsAndEraseDoubleConfirms() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "http://127.0.0.1:1/join/new-session-ui-test",
            "-uiTestFrozenFixture", "YES",
            "-uiTestOpenFrozenRail", "YES",
            "-uiTestOpenNewSession", "YES",
        ]
        app.launch()

        // The auto-opened dialog carries all three dispositions.
        let save = app.buttons["Save & start new"]
        XCTAssertTrue(save.waitForExistence(timeout: 60))
        XCTAssertTrue(app.buttons["New chat — skip memory"].exists)
        let erase = app.buttons["Erase & start new"]
        XCTAssertTrue(erase.exists)

        // Erase is irreversible, so it must not fire from the first dialog.
        erase.tap()
        let confirm = app.alerts["Erase the current session?"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.buttons["Cancel"].tap()

        // Cancelling leaves the sheet intact — nothing was sent or dismissed.
        XCTAssertTrue(app.buttons["new-session-button"].waitForExistence(timeout: 10))
    }
}
