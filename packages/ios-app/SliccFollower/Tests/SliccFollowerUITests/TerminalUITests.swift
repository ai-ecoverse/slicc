import XCTest

final class TerminalUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testFixtureRendersPromptAndPreservesTranscriptAcrossTabSwitch() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestOpenDockSurface", "term",
            "-uiTestTerminalFixture", "YES",
        ]
        app.launch()

        let surface = app.descendants(matching: .any)["terminal-surface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 60), "the Ghostty surface renders")

        let prompt = NSPredicate(format: "value CONTAINS %@", "slicc$ ")
        expectation(for: prompt, evaluatedWith: surface)
        waitForExpectations(timeout: 10)

        app.buttons["dock-files"].tap()
        let surfaceHidden = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: surface)
        XCTAssertEqual(
            XCTWaiter.wait(for: [surfaceHidden], timeout: 3), .completed,
            "collapsed terminal leaves are withdrawn from accessibility")

        app.buttons["dock-term"].tap()
        XCTAssertTrue(surface.waitForExistence(timeout: 10))
        XCTAssertTrue(prompt.evaluate(with: surface), "scrollback survives the tab switch")
    }

    func testDisconnectedPlaceholderCoversTerminal() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "disconnected",
            "-uiTestOpenDockSurface", "term",
            "-uiTestTerminalFixture", "YES",
        ]
        app.launch()

        let placeholder = app.staticTexts["terminal-disconnected"]
        XCTAssertTrue(
            placeholder.waitForExistence(timeout: 60),
            "a disconnected terminal asks for an active leader")
        XCTAssertTrue(placeholder.isHittable)
        XCTAssertFalse(app.descendants(matching: .any)["terminal-surface"].exists)
    }
}
