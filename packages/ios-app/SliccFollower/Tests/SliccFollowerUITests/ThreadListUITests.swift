import XCTest






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
        
        
        let unread = NSPredicate(format: "label CONTAINS %@", "active on leader · 2 unread turns")
        expectation(for: unread, evaluatedWith: rows[4])
        waitForExpectations(timeout: 10)
        attach(app, named: "compact-open")

        
        app.descendants(matching: .any)["thread-list-scrim"]
            .coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        XCTAssertTrue(waitForDisappearance(of: rows[0]))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "sliccy")

        
        app.buttons["scoop-switcher"].tap()
        XCTAssertTrue(rows[1].waitForExistence(timeout: 10))
        rows[1].tap()
        XCTAssertTrue(waitForDisappearance(of: rows[0]))
        XCTAssertEqual(app.buttons["scoop-switcher"].label, "researcher")
        XCTAssertFalse(app.staticTexts["composer-placeholder"].exists)

        
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

    
    
    
    
    func testAModelSummaryReplacingThePreviewDoesNotMoveTheListOrTheTranscript() {
        
        
        
        let app = launch(summaryDelayMs: 20_000, openList: true)
        let summaryIds = [
            "fixture-cone-main", "fixture-scoop-researcher", "fixture-scoop-summarizer",
            "fixture-scoop-reviewer", "fixture-cone-deploy", "fixture-scoop-tester",
        ]
        
        
        let mainRow = app.buttons["scoop-switch-fixture-cone-main"]
        
        
        let previewShown = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "Transcript of cone."), object: mainRow)
        let previewResult = XCTWaiter().wait(for: [previewShown], timeout: 15)
        XCTAssertEqual(
            previewResult, .completed,
            "preview value=\(mainRow.value ?? "nil") label=\(mainRow.label)")

        
        
        var anchors = summaryIds.map { "scoop-switch-\($0)" } + ["thread-list-close"]
        for extra in ["scoop-switcher", "message-fixture-cone-main-reply", "composer-placeholder"]
        where app.descendants(matching: .any)[extra].exists {
            anchors.append(extra)
        }
        let before = frames(of: anchors, in: app)
        attach(app, named: "summary-preview")

        for id in summaryIds {
            let row = app.buttons["scoop-switch-\(id)"]
            expectation(for: NSPredicate(format: "value == %@", "Pinned label"), evaluatedWith: row)
        }
        waitForExpectations(timeout: 25)
        let after = frames(of: anchors, in: app)
        attach(app, named: "summary-model-line")

        for anchor in anchors {
            assertSameFrame(
                before[anchor], after[anchor],
                "\(anchor) moved when the model line replaced the preview")
        }
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

    private func launch(
        width: Int? = nil, leftHanded: Bool = false, summaryDelayMs: Int? = nil, openList: Bool = false
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestThreadListFixture", "YES",
            "-uiTestReduceMotion", "YES",
            "-leftHandedDock", leftHanded ? "YES" : "NO",
            "-uiTestShellWidth", width.map(String.init) ?? "0",
        ]
        if let summaryDelayMs {
            app.launchArguments += ["-uiTestThreadSummaryDelay", String(summaryDelayMs)]
        }
        if openList {
            app.launchArguments += ["-uiTestThreadListOpen", "YES"]
        }
        app.launch()
        let ready = openList ? app.descendants(matching: .any)["thread-list"] : app.buttons["scoop-switcher"]
        XCTAssertTrue(ready.waitForExistence(timeout: 60))
        return app
    }

    private func frames(of identifiers: [String], in app: XCUIApplication) -> [String: CGRect] {
        Dictionary(
            uniqueKeysWithValues: identifiers.map { id in
                
                
                let element = app.descendants(matching: .any).matching(identifier: id).firstMatch
                XCTAssertTrue(element.waitForExistence(timeout: 5), id)
                return (id, element.frame)
            })
    }

    private func assertSameFrame(_ before: CGRect?, _ after: CGRect?, _ message: String) {
        XCTAssertEqual(after?.origin.x ?? -1, before?.origin.x ?? -2, accuracy: 0.5, message)
        XCTAssertEqual(after?.origin.y ?? -1, before?.origin.y ?? -2, accuracy: 0.5, message)
        XCTAssertEqual(after?.width ?? -1, before?.width ?? -2, accuracy: 0.5, message)
        XCTAssertEqual(after?.height ?? -1, before?.height ?? -2, accuracy: 0.5, message)
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
