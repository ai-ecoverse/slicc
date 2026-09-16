import XCTest

final class FrozenSessionsUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launchWithFrozenFixture(_ extraArguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()

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

        let banner = app.staticTexts["Frozen session — read-only"]
        XCTAssertTrue(banner.waitForExistence(timeout: 30))
        XCTAssertFalse(
            app.staticTexts["composer-placeholder"].exists,
            "The composer must not exist while a frozen session is open")

        XCTAssertTrue(app.staticTexts["What did we ship?"].waitForExistence(timeout: 30))

        XCTAssertFalse(app.buttons["frozen-rail-button"].exists)

        let back = app.buttons["frozen-back"]
        XCTAssertTrue(back.waitForExistence(timeout: 10))
        back.tap()
        XCTAssertFalse(banner.waitForExistence(timeout: 5))
        let rail = app.buttons["frozen-rail-button"]
        XCTAssertTrue(rail.waitForExistence(timeout: 10))

        rail.tap()
        let cardAgain = app.buttons["frozen-card-fixture-frozen-1"]
        XCTAssertTrue(cardAgain.waitForExistence(timeout: 30))
        cardAgain.tap()
        XCTAssertTrue(banner.waitForExistence(timeout: 30))
        app.staticTexts["What did we ship?"].swipeRight()
        XCTAssertFalse(banner.waitForExistence(timeout: 5))
        XCTAssertTrue(rail.waitForExistence(timeout: 10))
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
