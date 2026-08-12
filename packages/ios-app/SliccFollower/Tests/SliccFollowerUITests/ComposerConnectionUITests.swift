import XCTest

/// What connection trouble is allowed to do to the composer.
///
/// Kept apart from `ComposerKeyboardUITests` so CI can gate this class on its
/// own: those tests drive `typeKey` and need a hardware keyboard attached to
/// the simulator, which a runner does not have. These need nothing but the
/// leaderless fixture route, so the `ios-app-tests` iPhone leg runs them and a
/// regression cannot land unseen.
final class ComposerConnectionUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

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
        let app = launchApp(connectedWithBlip: "1")

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
        let app = launchApp(connectedWithBlip: "3")
        let composer = focusedComposer(in: app)
        composer.typeText("before")

        XCTAssertTrue(troubledAvatar(in: app).waitForExistence(timeout: 60))
        composer.typeText(" and after")

        XCTAssertTrue(
            (composer.value as? String)?.contains("before and after") == true,
            "A drop must not take the keyboard from someone mid-sentence")
    }

    /// The same drop, on an EMPTY composer — the state someone is in the
    /// instant they tap to start writing, and the one case the `.disabled`
    /// removal did not cover.
    ///
    /// `pttArmed` gated the push-to-talk surface on the connection, so a drop
    /// toggled `allowsHitTesting` on the focused editor and unmounted an
    /// overlay above it. The keyboard flapped even though nothing was typed.
    func testABlipOnAnEmptyComposerKeepsTheKeyboardUp() {
        // Drops at 3s and HEALS 3s later. The heal is the half that matters:
        // it re-arms `pttArmed`, which remounts the press surface on top of
        // the focused editor and flips its hit-testing back off. A drop alone
        // only unmounts, which the editor survives.
        let app = launchApp(connectedWithBlip: "3,3")
        let composer = focusedComposer(in: app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))

        // Nothing typed, so the composer stays empty across both edges —
        // which is what keeps `pttArmed` in play at all.
        Thread.sleep(forTimeInterval: 9)

        XCTAssertTrue(
            app.keyboards.count > 0,
            "A blip must not dismiss the keyboard under an empty composer")
        composer.typeText("still focused")
        XCTAssertTrue(
            (composer.value as? String)?.contains("still focused") == true,
            "A blip must not take focus from an empty composer either")
    }

    // MARK: - Helpers

    /// `joinUrl` is passed explicitly and empty so a value persisted by another
    /// test cannot start a real connection underneath the forced state.
    private func launchApp(forcing state: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-joinUrl", "", "-uiTestConnectionState", state]
        app.launch()
        return app
    }

    /// Starts connected, then drops for good after `blip` seconds — the
    /// transition the settle window exists for, which no pinned state can
    /// stage. The drop is permanent so the test waits for the treatment to
    /// land instead of racing the hold.
    private func launchApp(connectedWithBlip blip: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestConnectionBlip", blip,
        ]
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
