import XCTest

final class ICloudSessionsUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testFixtureSessionsListGroupedRowsAndTapConnects() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestSessionsFixture", "YES"]
        app.launch()

        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 60),
            "An empty join URL should open the Settings sheet on launch")

        let rows = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "icloud-session-"))
        XCTAssertTrue(
            rows.firstMatch.waitForExistence(timeout: 30),
            "Seeded fixture sessions should render as rows")
        XCTAssertEqual(rows.count, 3, "Both fixture devices' sessions should be listed")

        XCTAssertTrue(app.staticTexts["Chrome on Fixture MacBook"].exists)
        XCTAssertTrue(app.staticTexts["Chrome on Fixture Studio"].exists)

        rows.firstMatch.tap()
        let avatar = app.descendants(matching: .any)
            .matching(identifier: "scoop-avatar")
            .matching(NSPredicate(format: "label CONTAINS %@", "Connection Failed"))
            .firstMatch
        XCTAssertTrue(avatar.waitForExistence(timeout: 60))
        XCTAssertEqual(app.staticTexts["composer-placeholder"].label, "Disconnected")
    }

    func testEmptyStateNamesTheReason() {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestSessionsEmpty", "YES"]
        app.launch()

        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 60),
            "An empty join URL should open the Settings sheet on launch")
        XCTAssertTrue(
            app.otherElements["icloud-sessions-empty"].waitForExistence(timeout: 30)
                || app.staticTexts["icloud-sessions-empty"].waitForExistence(timeout: 5),
            "An empty session list should explain why it is empty")
    }

    func testRecentRowsRenderAndTapConnects() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestSessionsEmpty", "YES", "-uiTestRecentJoinsFixture", "YES",
        ]
        app.launch()

        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 60),
            "An empty join URL should open the Settings sheet on launch")

        let rows = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "recent-session-"))
        XCTAssertTrue(
            rows.firstMatch.waitForExistence(timeout: 30),
            "Seeded recents should render as rows")
        XCTAssertEqual(rows.count, 2, "This device's recent and the one synced from the iPad")

        XCTAssertTrue(app.staticTexts["Safari on Fixture MacBook"].exists)
        XCTAssertTrue(app.staticTexts["127.0.0.1:1"].exists)
        XCTAssertFalse(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "/join/")
            ).firstMatch.exists,
            "No row may render a join URL")

        rows.firstMatch.tap()
        let avatar = app.descendants(matching: .any)
            .matching(identifier: "scoop-avatar")
            .matching(NSPredicate(format: "label CONTAINS %@", "Connection Failed"))
            .firstMatch
        XCTAssertTrue(avatar.waitForExistence(timeout: 60))
    }

    func testNoRecentsMeansNoRecentSection() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestSessionsEmpty", "YES", "-uiTestRecentJoinsEmpty", "YES",
        ]
        app.launch()

        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 60),
            "An empty join URL should open the Settings sheet on launch")
        XCTAssertTrue(
            app.otherElements["icloud-sessions-empty"].waitForExistence(timeout: 30)
                || app.staticTexts["icloud-sessions-empty"].waitForExistence(timeout: 5))

        XCTAssertFalse(app.staticTexts["Recent"].exists)
    }
}
