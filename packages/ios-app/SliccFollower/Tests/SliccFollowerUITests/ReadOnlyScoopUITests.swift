import XCTest

/// The composer band belongs to the cone (#2367). Selecting a scoop opens a
/// read-only transcript: the band is not rendered at all, so nothing is
/// reserved and the transcript grows into the freed space.
final class ReadOnlyScoopUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testSelectingAScoopRemovesTheComposerAndReturningRestoresIt() {
        let app = launchUnitRoleApp()

        XCTAssertTrue(
            app.staticTexts["composer-placeholder"].waitForExistence(timeout: 10),
            "The cone keeps its composer")
        XCTAssertTrue(app.buttons["attach-menu"].exists, "The cone keeps its attach menu")
        attach(app.screenshot(), named: "cone-composer")

        select(jid: "fixture-owned-scoop", in: app)
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "reviewer")
        XCTAssertFalse(
            app.staticTexts["composer-placeholder"].waitForExistence(timeout: 3),
            "A selected scoop renders read-only — no composer")
        XCTAssertFalse(app.buttons["attach-menu"].exists, "No attachment affordance for a scoop")
        XCTAssertFalse(app.buttons["composer-send"].exists, "No send affordance for a scoop")
        attach(app.screenshot(), named: "scoop-read-only")

        // The band is unmounted rather than disabled — none of its elements
        // exist — so nothing is reserved and the transcript, which still
        // shows the scoop's output, grows into the freed space.
        let transcript = app.staticTexts["Reviewed 14 files. Two findings, both in the follower."]
        XCTAssertTrue(transcript.waitForExistence(timeout: 10), "Scoop output still renders")

        select(jid: "fixture-cone", in: app)
        XCTAssertTrue(
            app.staticTexts["composer-placeholder"].waitForExistence(timeout: 10),
            "Returning to the cone brings the composer back")
    }

    /// A deep link or a restored selection can open straight onto a scoop —
    /// the composer must never appear for one frame either.
    func testLaunchingOnAScoopNeverShowsAComposer() {
        let app = launchUnitRoleApp(variant: "scoop")

        XCTAssertEqual(app.buttons["scoop-switcher"].label, "reviewer")
        XCTAssertTrue(
            app.staticTexts["Reviewed 14 files. Two findings, both in the follower."]
                .waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["composer-placeholder"].exists)
        XCTAssertFalse(app.buttons["attach-menu"].exists)
    }

    private func launchUnitRoleApp(variant: String = "cone") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestUnitRoleFixture", variant,
            "-uiTestReduceMotion", "YES",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["scoop-switcher"].waitForExistence(timeout: 60))
        return app
    }

    private func select(jid: String, in app: XCUIApplication) {
        app.buttons["scoop-switcher"].tap()
        let option = app.buttons["scoop-switch-\(jid)"]
        XCTAssertTrue(option.waitForExistence(timeout: 10), "Fixture unit \(jid) should be selectable")
        option.tap()
    }

    private func attach(_ screenshot: XCUIScreenshot, named name: String) {
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
