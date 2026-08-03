import XCTest

/// The shared New Session dialog from both Past Sessions and the chat toolbar:
/// three clearly labeled dispositions, a visible Cancel below Erase, and erase
/// double-confirming before anything fires. Driven leaderless via UI fixtures.
final class NewSessionUITests: XCTestCase {

    private enum EntryPoint {
        case chat
        case pastSessions
    }

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testFirstDialogCancelDismissesWithoutRequestingANewSession() {
        let app = launchApp(opening: .pastSessions)
        let cancel = assertCancelableDialog(in: app)

        cancel.tap()

        XCTAssertFalse(app.buttons["Save & start new"].waitForExistence(timeout: 3))
        let caller = app.buttons["new-session-button"]
        XCTAssertTrue(
            caller.waitForExistence(timeout: 10),
            "Cancel must leave the Past Sessions caller intact instead of requesting a new session")
        XCTAssertTrue(caller.isEnabled)
    }

    func testChatToolbarCancelDismissesWithoutRequestingANewSession() {
        let app = launchApp(opening: .chat)
        let caller = app.buttons["new-chat-button"]
        XCTAssertTrue(caller.waitForExistence(timeout: 60))
        XCTAssertTrue(caller.isHittable)

        caller.tap()
        let cancel = assertCancelableDialog(in: app)
        cancel.tap()

        XCTAssertFalse(app.buttons["Save & start new"].waitForExistence(timeout: 3))
        XCTAssertTrue(
            caller.waitForExistence(timeout: 10),
            "Cancel must leave the chat toolbar caller intact instead of requesting a new session")
        XCTAssertTrue(caller.isEnabled, "Cancel must not put a new-session request in flight")
    }

    func testDialogOffersThreeActionsAndEraseDoubleConfirms() {
        let app = launchApp(opening: .pastSessions)

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

    private func launchApp(opening entryPoint: EntryPoint) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "http://127.0.0.1:1/join/new-session-ui-test",
        ]
        switch entryPoint {
        case .chat:
            app.launchArguments += ["-uiTestConnectionState", "connected"]
        case .pastSessions:
            app.launchArguments += [
                "-uiTestFrozenFixture", "YES",
                "-uiTestOpenFrozenRail", "YES",
                "-uiTestOpenNewSession", "YES",
            ]
        }
        app.launch()
        return app
    }

    private func assertCancelableDialog(in app: XCUIApplication) -> XCUIElement {
        let erase = app.buttons["Erase & start new"]
        XCTAssertTrue(erase.waitForExistence(timeout: 60))
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.exists, "The first dialog must expose a visible dismiss control")
        XCTAssertTrue(cancel.isHittable, "The first dialog's dismiss control must be tappable")
        XCTAssertGreaterThan(
            cancel.frame.midY, erase.frame.midY,
            "Erase & start new must not be the bottom-most control")
        return cancel
    }
}
