import XCTest

/// The inbound confirmation card (#1918): a received URL renders the
/// fail-closed card, Dismiss drops it, Open lands in full-screen browsing.
final class InboundActionsUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestInboundOpenURL", "https://example.com/docs",
        ]
        app.launch()
        return app
    }

    func testDeepLinkedOpenConfirmsBeforeOpening() {
        let app = launch()

        let alert = app.alerts["Open in Sliccy's browser?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 60), "the system alert renders")
        XCTAssertTrue(
            alert.staticTexts["https://example.com/docs"].exists,
            "the alert shows what would open")

        alert.buttons["Open"].tap()
        XCTAssertTrue(
            app.buttons["browser-address-display"].firstMatch.waitForExistence(timeout: 10),
            "confirming opens the URL as a full-screen local tab")
        XCTAssertFalse(
            app.buttons["dock-browser"].exists,
            "full-screen browsing hides the rail")
    }

    func testDismissDropsTheRequest() {
        let app = launch()

        let alert = app.alerts["Open in Sliccy's browser?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 60))
        alert.buttons["Cancel"].tap()
        XCTAssertFalse(
            app.alerts["Open in Sliccy's browser?"].exists,
            "cancel drops the request")
        XCTAssertTrue(
            app.buttons["dock-browser"].exists,
            "nothing opened — the shell stays put")
    }
}
