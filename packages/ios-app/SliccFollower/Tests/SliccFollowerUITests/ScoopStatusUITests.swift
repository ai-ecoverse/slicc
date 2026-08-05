import XCTest

/// Lifecycle and pupil-only context-fullness coverage for the leaderless scoop fixture.
final class ScoopStatusUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testLifecycleTreatmentsIncludeWorkingAndHonestUnknown() {
        let app = launchFixtureApp()

        assertSelection(
            jid: "fixture-working", label: "Working Scoop: working, 64% context fill",
            switcherLabel: "Working Scoop", in: app)
        assertSelection(
            jid: "fixture-broken", label: "Broken Scoop: broken, 82% context fill",
            switcherLabel: "Broken Scoop", in: app)
        assertSelection(
            jid: "fixture-initializing",
            label: "Initializing Scoop: initializing, 12% context fill",
            switcherLabel: "Initializing Scoop", in: app)
        assertSelection(
            jid: "fixture-idle", label: "Idle Scoop: idle, 0% context fill",
            switcherLabel: "Idle Scoop", in: app)
        assertSelection(
            jid: "fixture-unknown", label: "Unknown Scoop: unknown, context fill unknown",
            switcherLabel: "Unknown Scoop", in: app)

        let avatar = avatar(
            labeled: "Unknown Scoop: unknown, context fill unknown", in: app)
        XCTAssertFalse(avatar.label.contains("idle"), "Absent state must not read as idle")
        XCTAssertFalse(avatar.label.contains("0%"), "Absent fill must not read as zero")
    }

    func testNearLimitFullnessIsDistinctFromLowFill() {
        let app = launchFixtureApp(reduceMotion: true)
        select(jid: "fixture-near-limit", in: app)
        let nearLimitAvatar = avatar(
            labeled: "Near Limit Scoop: idle, 95% context fill", in: app)
        XCTAssertTrue(nearLimitAvatar.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "Near Limit Scoop")
        let nearLimitPupils = nearLimitAvatar.screenshot().pngRepresentation

        select(jid: "fixture-low-fill", in: app)
        let lowFillAvatar = avatar(labeled: "Low Fill Scoop: idle, 5% context fill", in: app)
        XCTAssertTrue(lowFillAvatar.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "Low Fill Scoop")
        XCTAssertNotEqual(
            lowFillAvatar.screenshot().pngRepresentation, nearLimitPupils,
            "Pupil size must remain the visible distinction between 95% and 5% context fill")
    }

    func testReducedMotionKeepsFullnessReadingPresent() {
        let app = launchFixtureApp(reduceMotion: true)

        select(jid: "fixture-working", in: app)
        let avatar = avatar(labeled: "Working Scoop: working, 64% context fill", in: app)
        XCTAssertTrue(avatar.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "Working Scoop")
    }

    func testStaticNoiseAvatarFixtureIsReachableAndFrozen() {
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestAvatarFixture", "light-static"]
        app.launch()

        XCTAssertTrue(
            app.staticTexts["avatar-fixture-static"].waitForExistence(timeout: 60),
            "The isolated avatar fixture should expose deterministic TV-static eyes")
        let firstFrame = app.screenshot().pngRepresentation
        Thread.sleep(forTimeInterval: 0.25)
        let secondFrame = app.screenshot().pngRepresentation
        XCTAssertGreaterThan(firstFrame.count, 1_000, "The frozen frame must render visible content")
        XCTAssertEqual(firstFrame, secondFrame, "Reduced motion must render one non-animating frame")
    }

    func testLongLabelHeaderStaysContainedAcrossHandedness() {
        for leftHanded in [false, true] {
            let app = launchFixtureApp(leftHanded: leftHanded)
            let mode = leftHanded ? "left-handed" : "normal"
            select(jid: "fixture-long", in: app)
            let navigationBar = app.navigationBars.firstMatch
            let avatar = app.descendants(matching: .any)["scoop-avatar"]
            let switcher = app.buttons["scoop-switcher"]
            XCTAssertTrue(navigationBar.waitForExistence(timeout: 10), "\(mode) bar should exist")
            XCTAssertTrue(avatar.waitForExistence(timeout: 10), "\(mode) avatar should exist")
            XCTAssertTrue(switcher.isHittable, "\(mode) switcher must remain reachable")
            XCTAssertEqual(
                avatar.label,
                "Scoop with a deliberately overlong assistant label: idle, 20% context fill")
            assertContained(avatar, in: navigationBar, mode: mode)
            assertContained(switcher, in: navigationBar, mode: mode)
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = "long-label-header-\(mode)"
            attachment.lifetime = .keepAlways
            add(attachment)
            for identifier in ["frozen-rail-button", "settings-button", "new-chat-button"] {
                let control = app.buttons[identifier]
                XCTAssertTrue(control.isHittable, "\(mode) \(identifier) must remain reachable")
            }
            app.terminate()
        }
    }

    private func launchFixtureApp(
        reduceMotion: Bool = false,
        leftHanded: Bool = false
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestScoopStatusFixture", "YES",
            "-uiTestReduceMotion", reduceMotion ? "YES" : "NO",
            "-leftHandedDock", leftHanded ? "YES" : "NO",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["scoop-switcher"].waitForExistence(timeout: 60))
        return app
    }

    private func assertContained(
        _ element: XCUIElement, in container: XCUIElement, mode: String
    ) {
        let bounds = container.frame.insetBy(dx: -0.5, dy: -0.5)
        XCTAssertTrue(
            bounds.contains(element.frame),
            "\(mode) \(element.identifier) frame \(element.frame) must stay inside \(container.frame)")
    }

    private func assertSelection(
        jid: String, label: String, switcherLabel: String, in app: XCUIApplication
    ) {
        select(jid: jid, in: app)
        let avatar = avatar(labeled: label, in: app)
        XCTAssertTrue(avatar.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, switcherLabel)
    }

    private func avatar(labeled label: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "scoop-avatar")
            .matching(NSPredicate(format: "label == %@", label))
            .firstMatch
    }

    private func select(jid: String, in app: XCUIApplication) {
        let switcher = app.buttons["scoop-switcher"]
        switcher.tap()
        let option = app.buttons["scoop-switch-\(jid)"]
        XCTAssertTrue(option.waitForExistence(timeout: 10), "Fixture scoop \(jid) should be selectable")
        option.tap()
    }
}
