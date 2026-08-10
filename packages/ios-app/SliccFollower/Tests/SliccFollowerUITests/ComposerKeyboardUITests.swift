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
            app.staticTexts["composer-placeholder"].waitForExistence(timeout: 10),
            "plain Return should submit and clear the composed prompt")
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

    func testCommandReturnDoesNotSubmit() {
        let app = launchConnectedApp()
        let composer = focusedComposer(in: app)

        composer.typeText("keep this draft")
        app.typeKey(.return, modifierFlags: .command)

        XCTAssertTrue(
            (composer.value as? String)?.contains("keep this draft") == true,
            "modified Return should not submit the composed prompt")
        XCTAssertFalse(app.staticTexts["keep this draft"].exists)
    }

    // MARK: - Connection trouble

    /// An unusable leader blocks SENDING, never typing. Disabling the band
    /// disabled the `TextEditor` inside it, which resigned first responder and
    /// took the keyboard with it — mid-sentence, for a fault that was usually
    /// over a second later.
    func testTheComposerStaysTypableWhileDisconnected() {
        let app = launchApp(forcing: "failed")
        let composer = focusedComposer(in: app)

        composer.typeText("draft written while the leader is gone")

        XCTAssertTrue(
            (composer.value as? String)?.contains("draft written while the leader is gone")
                == true,
            "A disconnect must not refuse typing")
        XCTAssertFalse(
            app.buttons["composer-send"].isEnabled,
            "Sending is what an unusable leader blocks")
    }

    /// The keyboard belongs to composer focus and to nothing else: reaching
    /// trouble with no one typing must not raise it.
    func testReachingTroubleDoesNotRaiseTheKeyboard() {
        let app = launchConnectedApp(blip: "1")

        XCTAssertTrue(
            troubledAvatar(in: app).waitForExistence(timeout: 60),
            "the staged drop should reach the avatar once the hold expires")
        XCTAssertEqual(
            app.keyboards.count, 0,
            "A connection change must never open the keyboard on its own")
    }

    /// The other half of the same coupling: a drop must not yank focus away
    /// from someone who is mid-sentence. `typeText` only lands while the
    /// element still holds keyboard focus, so it is the assertion.
    func testADropKeepsTheComposerFocused() {
        let app = launchConnectedApp(blip: "3")
        let composer = focusedComposer(in: app)
        composer.typeText("before")

        XCTAssertTrue(troubledAvatar(in: app).waitForExistence(timeout: 60))
        composer.typeText(" and after")

        XCTAssertTrue(
            (composer.value as? String)?.contains("before and after") == true,
            "A drop must not take the keyboard from someone mid-sentence")
    }

    // MARK: - Helpers

    private func launchConnectedApp(blip: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", "connected"]
        if let blip {
            app.launchArguments += ["-uiTestConnectionBlip", blip]
        }
        app.launch()
        return app
    }

    private func launchApp(forcing state: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", state]
        app.launch()
        return app
    }

    /// The avatar once the connection treatment has landed. A staged drop is
    /// held for the settle window first, so every assertion about it waits.
    private func troubledAvatar(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "scoop-avatar")
            .matching(NSPredicate(format: "label CONTAINS %@", "Reconnecting"))
            .firstMatch
    }

    private func focusedComposer(in app: XCUIApplication) -> XCUIElement {
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 60))
        composer.tap()
        return composer
    }
}
