import XCTest

/// UI coverage for the freezer rail, seeded through `-uiTestFrozenFixture` /
/// `-uiTestFrozenEmpty` so no test needs a leader. Covers the list, the
/// read-only frozen state (composer gone, banner present), and the empty
/// state, per the issue's acceptance criteria.
final class FrozenSessionsUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launchWithFrozenFixture(_ extraArguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        // A non-empty joinUrl skips the auto-opened Settings sheet; the
        // connection fails instantly against 127.0.0.1:1, which is fine —
        // the frozen fixtures render leaderless.
        app.launchArguments += ["-joinUrl", "http://127.0.0.1:1/join/frozen-ui-test"]
        app.launchArguments += extraArguments
        app.launch()
        return app
    }

    func testFixtureSessionsListOpensAndReadsFrozenSessionReadOnly() {
        let app = launchWithFrozenFixture(["-uiTestFrozenFixture", "YES"])

        let railButton = app.buttons["frozen-rail-button"]
        XCTAssertTrue(railButton.waitForExistence(timeout: 60))
        railButton.tap()

        let card = app.buttons["frozen-card-fixture-frozen-1"]
        XCTAssertTrue(card.waitForExistence(timeout: 30), "Fixture sessions should render as cards")
        XCTAssertTrue(app.staticTexts["Fix the build"].exists)

        card.tap()

        // Read-only view: banner present, composer absent.
        let banner = app.staticTexts["Frozen session — read-only"]
        XCTAssertTrue(banner.waitForExistence(timeout: 30))
        XCTAssertFalse(
            app.staticTexts["composer-placeholder"].exists,
            "The composer must not exist while a frozen session is open")

        // The archived transcript renders through the normal message list.
        XCTAssertTrue(app.staticTexts["What did we ship?"].waitForExistence(timeout: 30))

        // Back to live restores the composer surface.
        app.buttons["frozen-close"].tap()
        XCTAssertFalse(banner.waitForExistence(timeout: 3))
    }

    func testEmptyFreezerNamesItself() {
        let app = launchWithFrozenFixture(["-uiTestFrozenEmpty", "YES"])

        let railButton = app.buttons["frozen-rail-button"]
        XCTAssertTrue(railButton.waitForExistence(timeout: 60))
        railButton.tap()

        XCTAssertTrue(
            app.staticTexts["No archived sessions"].waitForExistence(timeout: 30),
            "An empty freezer should say so rather than showing a blank sheet")
    }
}
