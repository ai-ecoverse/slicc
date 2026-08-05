import XCTest

final class OpenApprovalUITests: XCTestCase {
    func testApprovalFixtureShowsAllThreeActionsWithoutExposingQueryValues() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-uiTestOpenApproval", "YES",
            "-joinUrl", "",
        ]
        app.launch()

        XCTAssertTrue(app.buttons["open-approval-deny"].waitForExistence(timeout: 60))
        XCTAssertTrue(app.buttons["open-approval-once"].exists)
        XCTAssertTrue(app.buttons["open-approval-always"].exists)
        XCTAssertFalse(app.staticTexts["never-display"].exists)
        XCTAssertFalse(
            app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", "never-display"))
                .firstMatch.exists)

        // The fixture is staged through the controller, so Deny settles the
        // request rather than leaving the card up on unreachable state.
        app.buttons["open-approval-deny"].tap()
        XCTAssertTrue(
            app.buttons["open-approval-deny"].waitForNonExistence(timeout: 10))
    }
}
