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

    /// The Recent list is the half iCloud discovery cannot cover: a join URL
    /// pasted on another device is advertised by nobody, so only the synced
    /// history can offer it here.
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

        // A labelled row shows its label; the hand-pasted one falls back to the
        // host — never the secret-bearing path.
        XCTAssertTrue(app.staticTexts["Safari on Fixture MacBook"].exists)
        XCTAssertTrue(app.staticTexts["127.0.0.1:1"].exists)
        XCTAssertFalse(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "/join/")
            ).firstMatch.exists,
            "No row may render a join URL")

        // Same proof as the iCloud list: the fixture URL is refused instantly,
        // so Failed means the tap really dialed.
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
        // An empty history shows nothing at all — no header for a list of none.
        XCTAssertFalse(app.staticTexts["Recent"].exists)
    }
}
