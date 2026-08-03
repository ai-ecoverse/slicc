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

        let transcript = app.staticTexts["terminal-transcript"]
        let prompt = NSPredicate(format: "label CONTAINS %@", "slicc$ ")
        expectation(for: prompt, evaluatedWith: transcript)
        waitForExpectations(timeout: 10)

        app.buttons["dock-files"].tap()
        app.buttons["dock-term"].tap()
        XCTAssertTrue(surface.waitForExistence(timeout: 10))
        XCTAssertTrue(prompt.evaluate(with: transcript), "scrollback survives the tab switch")
    }

    func testDisconnectedPlaceholderCoversTerminal() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "disconnected",
            "-uiTestOpenDockSurface", "term",
            "-uiTestTerminalFixture", "YES",
        ]
        app.launch()

        XCTAssertTrue(
            app.staticTexts["terminal-disconnected"].waitForExistence(timeout: 60),
            "a disconnected terminal asks for an active leader")
    }
}
