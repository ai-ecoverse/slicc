import XCTest

/// Lifecycle and context-fullness coverage for the leaderless scoop fixture.
final class ScoopStatusUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testLifecycleTreatmentsIncludeWorkingAndHonestUnknown() {
        let app = launchFixtureApp()

        assertSelection(
            jid: "fixture-working", label: "Working Scoop: working, 64% context fill",
            treatment: "scoop-lifecycle-working", in: app)
        assertSelection(
            jid: "fixture-broken", label: "Broken Scoop: broken, 82% context fill",
            treatment: "scoop-lifecycle-broken", in: app)
        assertSelection(
            jid: "fixture-initializing",
            label: "Initializing Scoop: initializing, 12% context fill",
            treatment: "scoop-lifecycle-initializing", in: app)
        assertSelection(
            jid: "fixture-idle", label: "Idle Scoop: idle, 0% context fill",
            treatment: "scoop-lifecycle-idle", in: app)
        assertSelection(
            jid: "fixture-unknown", label: "Unknown Scoop: unknown, context fill unknown",
            treatment: "scoop-lifecycle-unknown", in: app)

        let switcher = app.buttons["scoop-switcher"]
        XCTAssertFalse(switcher.label.contains("idle"), "Absent state must not read as idle")
        XCTAssertFalse(switcher.label.contains("0%"), "Absent fill must not read as zero")
        XCTAssertTrue(app.descendants(matching: .any)["scoop-fullness-unknown"].exists)
    }

    func testNearLimitFullnessIsDistinctFromLowFill() {
        let app = launchFixtureApp()

        select(jid: "fixture-near-limit", in: app)
        XCTAssertTrue(
            app.descendants(matching: .any)["scoop-fullness-near-limit"].waitForExistence(
                timeout: 10))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "Near Limit Scoop: idle, 95% context fill")

        select(jid: "fixture-low-fill", in: app)
        XCTAssertTrue(
            app.descendants(matching: .any)["scoop-fullness-normal"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "Low Fill Scoop: idle, 5% context fill")
    }

    func testReducedMotionKeepsFullnessReadingPresent() {
        let app = launchFixtureApp(reduceMotion: true)

        select(jid: "fixture-working", in: app)
        XCTAssertTrue(
            app.descendants(matching: .any)["scoop-fullness-normal"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "Working Scoop: working, 64% context fill")
    }

    private func launchFixtureApp(reduceMotion: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestScoopStatusFixture", "YES",
            "-uiTestReduceMotion", reduceMotion ? "YES" : "NO",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["scoop-switcher"].waitForExistence(timeout: 60))
        return app
    }

    private func assertSelection(
        jid: String, label: String, treatment: String, in app: XCUIApplication
    ) {
        select(jid: jid, in: app)
        XCTAssertEqual(app.buttons["scoop-switcher"].label, label)
        XCTAssertTrue(app.descendants(matching: .any)[treatment].waitForExistence(timeout: 10))
    }

    private func select(jid: String, in app: XCUIApplication) {
        let switcher = app.buttons["scoop-switcher"]
        switcher.tap()
        let option = app.buttons["scoop-switch-\(jid)"]
        XCTAssertTrue(option.waitForExistence(timeout: 10), "Fixture scoop \(jid) should be selectable")
        option.tap()
    }
}
