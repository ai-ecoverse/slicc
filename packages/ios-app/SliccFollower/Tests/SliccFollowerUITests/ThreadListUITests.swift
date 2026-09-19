import XCTest

/// The thread list that replaced the switcher menu: a slide-over at compact
/// width, a persistent sidebar at regular width. Every test runs off
/// `-uiTestThreadListFixture` — two cones, owned and nested scoops, every
/// marker — so none needs a leader. Compact tests pin `-uiTestShellWidth`, so
/// they exercise the same shape on the iPhone and the iPad cell.
final class ThreadListUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    func testSlideOverNestsScoopsUnderTheirConeAndCarriesEveryMarker() {
        let app = launch(width: 390)
        XCTAssertFalse(app.buttons["scoop-switch-fixture-cone-main"].exists, "Starts closed")
        // A toolbar Button once squeezed the label to nothing, leaving a bare
        // chevron: the pill must be wide enough to show its text.
        XCTAssertGreaterThan(app.buttons["scoop-switcher"].frame.width, 40)
        attach(app, named: "compact-closed")
        app.buttons["scoop-switcher"].tap()

        let order = [
            "fixture-cone-main", "fixture-scoop-researcher", "fixture-scoop-summarizer",
            "fixture-scoop-reviewer", "fixture-cone-deploy", "fixture-scoop-tester",
        ]
        let rows = order.map { app.buttons["scoop-switch-\($0)"] }
        XCTAssertTrue(rows[0].waitForExistence(timeout: 10))
        for (upper, lower) in zip(rows, rows.dropFirst()) {
            XCTAssertLessThan(upper.frame.minY, lower.frame.minY, "\(lower.identifier) order")
        }
        XCTAssertTrue(rows[1].label.contains("running a tool · scoop · read-only"), rows[1].label)
        XCTAssertTrue(rows[3].label.hasPrefix("reviewer: broken, 82% context fill"), rows[3].label)
        XCTAssertTrue(rows[0].label.contains("waiting for you · cone"), rows[0].label)
        XCTAssertTrue(rows[0].label.hasSuffix("claude-opus-4-6"), rows[0].label)
        XCTAssertTrue(rows[0].isSelected)
        // Unread arrives through the real roster path: two turns end on
        // deploy-bot while the main cone is selected.
        let unread = NSPredicate(format: "label CONTAINS %@", "active on leader · 2 unread turns")
        expectation(for: unread, evaluatedWith: rows[4])
        waitForExpectations(timeout: 10)
        attach(app, named: "compact-open")

        // Tap outside dismisses without selecting anything.
        app.descendants(matching: .any)["thread-list-scrim"]
            .coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        XCTAssertTrue(waitForDisappearance(of: rows[0]))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "sliccy")

        // A pick selects, closes the slide-over, and a scoop is read-only.
        app.buttons["scoop-switcher"].tap()
        XCTAssertTrue(rows[1].waitForExistence(timeout: 10))
        rows[1].tap()
        XCTAssertTrue(waitForDisappearance(of: rows[0]))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "researcher")
        XCTAssertFalse(app.staticTexts["composer-placeholder"].exists)

        // Selecting the cone with unread clears it: selection is the receipt.
        app.buttons["scoop-switcher"].tap()
        XCTAssertTrue(rows[4].waitForExistence(timeout: 10))
        rows[4].tap()
        XCTAssertTrue(waitForDisappearance(of: rows[0]))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "deploy-bot")
        app.buttons["scoop-switcher"].tap()
        XCTAssertTrue(rows[4].waitForExistence(timeout: 10))
        XCTAssertFalse(rows[4].label.contains("unread"), rows[4].label)
    }

    func testSlideOverDismissesWithADragTowardItsEdge() {
        let app = launch(width: 390)
        app.buttons["scoop-switcher"].tap()
        let row = app.buttons["scoop-switch-fixture-cone-deploy"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
            .press(
                forDuration: 0.05,
                thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: -0.6, dy: 0.5)))
        XCTAssertTrue(waitForDisappearance(of: row))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "sliccy", "A drag is not a pick")
    }

    func testLeftHandedSlideOverComesFromTheTrailingEdge() {
        let app = launch(width: 390, leftHanded: true)
        app.buttons["scoop-switcher"].tap()
        let row = app.buttons["scoop-switch-fixture-cone-main"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let window = app.windows.firstMatch.frame
        XCTAssertGreaterThan(row.frame.midX, window.midX, "Opens on the switcher's side")
        attach(app, named: "compact-open-left-handed")
    }

    /// A regular-width window keeps the list as a sidebar: open at launch,
    /// open after a pick, folded by the pill. Skipped where the window is too
    /// narrow for one — the phone cell — rather than by device idiom.
    func testRegularSidebarStaysOpenAcrossPicksAndFoldsFromThePill() throws {
        let app = launch()
        let main = app.buttons["scoop-switch-fixture-cone-main"]
        guard main.waitForExistence(timeout: 5) else {
            throw XCTSkip("Window too narrow for a sidebar; the slide-over tests cover it")
        }
        attach(app, named: "regular-sidebar-portrait")
        let deploy = app.buttons["scoop-switch-fixture-cone-deploy"]
        deploy.tap()
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "deploy-bot")
        XCTAssertTrue(main.exists, "A sidebar stays open after a pick")
        XCTAssertTrue(app.staticTexts["composer-placeholder"].exists, "The conversation keeps its composer")

        app.buttons["scoop-switcher"].tap()
        XCTAssertTrue(waitForDisappearance(of: main))
        app.buttons["scoop-switcher"].tap()
        XCTAssertTrue(main.waitForExistence(timeout: 10))

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(main.waitForExistence(timeout: 10))
        XCTAssertLessThan(main.frame.minX, app.windows.firstMatch.frame.midX)
        attach(app, named: "regular-sidebar-landscape")
    }

    private func launch(width: Int? = nil, leftHanded: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestThreadListFixture", "YES",
            "-uiTestReduceMotion", "YES",
            "-leftHandedDock", leftHanded ? "YES" : "NO",
            "-uiTestShellWidth", width.map(String.init) ?? "0",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["scoop-switcher"].waitForExistence(timeout: 60))
        return app
    }

    private func waitForDisappearance(of element: XCUIElement) -> Bool {
        let gone = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [gone], timeout: 10) == .completed
    }

    private func attach(_ app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
