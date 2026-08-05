import XCTest

/// Hardware-keyboard behavior for the chat composer against the leaderless
/// connected fixture.
final class ComposerKeyboardUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testReturnSubmitsPrompt() {
        let app = launchConnectedApp()
        let composer = focusedComposer(in: app)

        composer.typeText("send from keyboard")
        app.typeKey(.return, modifierFlags: [])

        XCTAssertTrue(
            app.staticTexts["send from keyboard"].waitForExistence(timeout: 10),
            "plain Return should submit the composed prompt")
    }

    func testShiftReturnInsertsLineBreak() {
        let app = launchConnectedApp()
        let composer = focusedComposer(in: app)

        composer.typeText("first line")
        app.typeKey(.return, modifierFlags: .shift)
        composer.typeText("second line")

        XCTAssertTrue(
            (composer.value as? String)?.contains("first line\nsecond line") == true,
            "Shift-Return should keep both lines in the composer")
    }

    private func launchConnectedApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", "connected"]
        app.launch()
        return app
    }

    private func focusedComposer(in app: XCUIApplication) -> XCUIElement {
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 60))
        composer.tap()
        return composer
    }
}
