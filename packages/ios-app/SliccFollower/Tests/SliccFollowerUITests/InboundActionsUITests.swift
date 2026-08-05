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

        let card = app.staticTexts["Open in SLICC's browser?"]
        XCTAssertTrue(card.waitForExistence(timeout: 60), "the confirmation card renders")
        XCTAssertTrue(
            app.staticTexts["example.com"].exists,
            "the host leads the trust decision")

        app.buttons["inbound-open-confirm"].firstMatch.tap()
        XCTAssertTrue(
            app.buttons["browser-address-display"].firstMatch.waitForExistence(timeout: 10),
            "confirming opens the URL as a full-screen local tab")
        XCTAssertFalse(
            app.buttons["dock-browser"].exists,
            "full-screen browsing hides the rail")
    }

    func testDismissDropsTheRequest() {
        let app = launch()

        let dismiss = app.buttons["inbound-open-dismiss"].firstMatch
        XCTAssertTrue(dismiss.waitForExistence(timeout: 60))
        dismiss.tap()
        XCTAssertFalse(
            app.staticTexts["Open in SLICC's browser?"].exists,
            "dismiss drops the card")
        XCTAssertTrue(
            app.buttons["dock-browser"].exists,
            "nothing opened — the shell stays put")
    }
}
