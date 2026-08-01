import XCTest

/// UI coverage for the Settings "iCloud Sessions" list, seeded through the
/// `-uiTestSessionsFixture` / `-uiTestSessionsEmpty` hooks so no test touches
/// real iCloud. Fixture join URLs dial 127.0.0.1:1, the same hermetic
/// unreachable endpoint the connection-route tests use.
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

        // Rows are identified by the one-way session id — never the join URL —
        // so match on the stable prefix instead of hardcoding hashes.
        let rows = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "icloud-session-"))
        XCTAssertTrue(
            rows.firstMatch.waitForExistence(timeout: 30),
            "Seeded fixture sessions should render as rows")
        XCTAssertEqual(rows.count, 3, "Both fixture devices' sessions should be listed")

        // Device and label text surface from the fixture payloads.
        XCTAssertTrue(app.staticTexts["Chrome on Fixture MacBook"].exists)
        XCTAssertTrue(app.staticTexts["Chrome on Fixture Studio"].exists)

        // Tapping a row threads its join URL into the real connect path. The
        // fixture URL is refused instantly, so the settled state is Failed —
        // which proves the tap connected rather than just closing the sheet.
        rows.firstMatch.tap()
        let pill = app.staticTexts["connection-status"]
        XCTAssertTrue(pill.waitForExistence(timeout: 30))
        let failed = NSPredicate(format: "label == %@", "Connection Failed")
        expectation(for: failed, evaluatedWith: pill)
        waitForExpectations(timeout: 60)
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
}
