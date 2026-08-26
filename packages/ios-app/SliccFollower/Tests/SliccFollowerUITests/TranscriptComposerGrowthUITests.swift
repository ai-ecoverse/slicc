import XCTest

/// Regression cover for #2072: the transcript threw the reader backwards
/// through the history whenever the keyboard's inset landed.
///
/// The cause was ours, not the platform's. `MessageListView` bound a
/// `ScrollPosition` to the transcript's `ScrollView` and hand-rolled
/// bottom-pinning on top of it; restoring that binding's (estimated) offset
/// across a container resize is exactly the operation WWDC26 "Dive into lazy
/// stacks and scrolling with SwiftUI" says a lazy stack cannot do reliably.
/// `.defaultScrollAnchor(.bottom)` is a layout rule resolved *after* the
/// resize, so there is no offset to restore.
///
/// Measured on an iPhone 17e simulator, iOS 26.5: the anchor row moved
/// **+258pt** before the fix and **0pt** after it. These tests assert that
/// measured property — drift across a keyboard transition — rather than mere
/// rendering, because only the measurement catches a reintroduction.
final class TranscriptComposerGrowthUITests: XCTestCase {

    /// How far the anchor row may move while the composer and keyboard claim
    /// their space. The fix measures 0pt; the regression measures ~258pt
    /// against a ~301pt inset. This sits far enough above 0 to absorb layout
    /// rounding and device-size differences, and far enough below the
    /// regression to fail on it.
    private let allowedDrift: CGFloat = 60

    private let anchorId = "message-fx-delegation-1"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: - #2072

    func testHistoryStaysPutWhenTheComposerAndKeyboardClaimSpace() throws {
        let app = launchWithTranscript()
        let anchor = app.descendants(matching: .any)
            .matching(identifier: anchorId).firstMatch
        waitForSeededTranscript(app)

        // Scrolling back is load-bearing. Until the reader drags, the
        // transcript is still pinned to the bottom by its own anchor, and a
        // viewport that shrinks against a bottom pin is re-pinned for free.
        // Only once the position is the *reader's* does the resize have to
        // preserve it, and that is the path #2072 broke. Four earlier
        // reproduction attempts came back clean for exactly this reason.
        scrollBackUntilAnchorIsCentred(app: app, anchor: anchor)
        let afterScroll = anchor.frame.midY

        let composer = focusedComposer(app)
        // The inset can land a render pass after the keyboard reports itself
        // present, so settle before sampling — reading in between shows
        // "focus changes nothing", which is what killed two earlier
        // hypotheses.
        Thread.sleep(forTimeInterval: 1.5)

        XCTAssertLessThan(
            abs(anchor.frame.midY - afterScroll), allowedDrift,
            "the keyboard's inset threw the reader through the history "
                + "(moved \(anchor.frame.midY - afterScroll)pt)")

        type("x", into: composer, app: app)
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertLessThan(
            abs(anchor.frame.midY - afterScroll), allowedDrift,
            "the first keystroke threw the reader through the history "
                + "(moved \(anchor.frame.midY - afterScroll)pt)")

        type(
            " and now a great deal more text that wraps onto four separate lines",
            into: composer, app: app)
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertLessThan(
            abs(anchor.frame.midY - afterScroll), allowedDrift,
            "growing the composer threw the reader through the history "
                + "(moved \(anchor.frame.midY - afterScroll)pt)")
    }

    /// The other half of the fix: `defaultScrollAnchor(.bottom)` replaced five
    /// `.onChange` handlers that force-scrolled to the bottom, so the list
    /// must still follow new content on its own. Sending exercises the real
    /// `AppState.sendMessage` append path rather than a fixture hook.
    func testTranscriptStillFollowsANewlySentMessage() throws {
        let app = launchWithTranscript()
        waitForSeededTranscript(app)

        let composer = focusedComposer(app)
        let sent = "does the transcript follow me"
        type(sent, into: composer, app: app)

        tapSend(app)

        let sentBubble = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", sent)
        ).firstMatch
        XCTAssertTrue(
            sentBubble.waitForExistence(timeout: 10),
            "the sent message should be in the transcript")
        XCTAssertTrue(
            sentBubble.isHittable,
            "the transcript must scroll to a newly sent message, not leave it below the fold")
    }

    /// A reader who has scrolled back must NOT be yanked to the bottom by
    /// INCOMING content. The old `.onChange` handlers force-scrolled on any
    /// content change and threw a reader out of the history mid-sentence.
    ///
    /// This uses a scheduled cone message, not a send: the user's own message
    /// deliberately always wins, so a send cannot test this rule.
    func testAnIncomingMessageDoesNotYankAReaderOutOfTheHistory() throws {
        let appendAfter: Double = 15
        let app = launchWithTranscript(appendAfterSeconds: appendAfter)
        let anchor = app.descendants(matching: .any)
            .matching(identifier: anchorId).firstMatch
        waitForSeededTranscript(app)

        scrollBackUntilAnchorIsCentred(app: app, anchor: anchor)
        let beforeIncoming = anchor.frame.midY

        // Outlast the scheduled append. Waiting on the new row's *existence*
        // would not work: the reader is deliberately far from the bottom, so
        // the row is real in the model but never materialized by the lazy
        // stack. Its arrival is proved at the end instead.
        Thread.sleep(forTimeInterval: appendAfter + 8)

        XCTAssertTrue(anchor.exists, "the reader's row must survive an incoming message")
        XCTAssertLessThan(
            abs(anchor.frame.midY - beforeIncoming), allowedDrift,
            "an incoming message yanked the reader out of the history "
                + "(moved \(anchor.frame.midY - beforeIncoming)pt)")

        // Now prove the message really did arrive, so the assertion above was
        // not vacuous.
        let incoming = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "arrived while you were reading back")
        ).firstMatch
        let low = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
        let high = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.20))
        for _ in 0..<12 where !incoming.exists {
            low.press(
                forDuration: 0.1, thenDragTo: high, withVelocity: .slow,
                thenHoldForDuration: 0)
        }
        XCTAssertTrue(
            incoming.exists,
            "the scheduled incoming message should have reached the transcript")
    }

    // MARK: - Helpers

    /// Drags the transcript back until the anchor row sits in the middle of
    /// the viewport, so the measurement always starts from a comparable
    /// reading position.
    ///
    /// Coordinate drags, not `element.swipeDown()`: the anchor is offscreen at
    /// launch (the list opens at the bottom) and `app.scrollViews.firstMatch`
    /// resolves to one of `HorizontalScrollGuard`'s zero-width horizontal
    /// scrollers, so both element-proxy routes fail with "visible frame is
    /// empty".
    private func scrollBackUntilAnchorIsCentred(app: XCUIApplication, anchor: XCUIElement) {
        // Both ends stay in the upper half: with the keyboard up, 0.78 of the
        // screen is inside it and the drag never reaches the transcript.
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.20))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
        for _ in 0..<20 {
            // `.frame` on an unmaterialized row throws "failed to get matching
            // snapshot". This row IS materialized at launch but sits far above
            // the viewport (measured y = -630), so gate on `isHittable`, not
            // just `exists`.
            if anchor.exists, anchor.isHittable {
                let y = anchor.frame.midY
                if y > 150 && y < 650 { break }
            }
            // `.slow` matters: a flung drag travels 300-800pt unpredictably and
            // oscillates past the window, so a fast drag can miss 20 times.
            top.press(
                forDuration: 0.1, thenDragTo: bottom, withVelocity: .slow,
                thenHoldForDuration: 0)
        }
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertTrue(
            anchor.exists && anchor.isHittable,
            "anchor row should be on screen to measure against")
    }

    /// Taps send once it is actually enabled.
    ///
    /// `canSend` only flips a render pass after the composer's text changes,
    /// and tapping a DISABLED `XCUIElement` is a silent no-op — the tap is
    /// swallowed, the test sails on, and the missing message surfaces as a
    /// confusing assertion much later. Wait for `isEnabled` first.
    private func tapSend(_ app: XCUIApplication) {
        let send = app.buttons["composer-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "send button should exist")
        let enabled = expectation(
            for: NSPredicate(format: "isEnabled == true"), evaluatedWith: send)
        wait(for: [enabled], timeout: 10)
        send.tap()
    }

    /// Types into the focused composer and proves the text landed.
    ///
    /// Uses `app.typeText`, not `composer.typeText`: the element form re-taps
    /// to focus, and an empty composer hit-disables its editor underneath
    /// `PttPressSurface` (hold-to-talk), so that tap can arm dictation instead
    /// of placing a caret and the keystrokes go nowhere. Asserting the value
    /// afterwards is what stops a test passing on input it never delivered.
    private func type(_ text: String, into composer: XCUIElement, app: XCUIApplication) {
        let before = (composer.value as? String) ?? ""
        app.typeText(text)
        let after = (composer.value as? String) ?? ""
        XCTAssertTrue(
            after.contains(text.trimmingCharacters(in: .whitespaces)),
            "typing should reach the composer (before: '\(before)', after: '\(after)')")
    }

    /// Taps the composer and waits for the keyboard before returning it.
    ///
    /// An empty composer mounts `PttPressSurface` **over** the editor and
    /// hit-disables it (hold-to-talk), so the tap reaches the press surface and
    /// focus arrives a beat later through its `quickTap` event. Typing without
    /// waiting drops the text on the floor, `canSend` stays false, and the send
    /// silently does nothing.
    private func focusedComposer(_ app: XCUIApplication) -> XCUIElement {
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "composer should exist")
        composer.tap()
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 10),
            "tapping the composer should raise the keyboard")
        return composer
    }

    /// The transcript opens pinned to its bottom, so no *particular* row is
    /// guaranteed to be materialized at launch. Gate on the composer and on
    /// the newest fixture row instead, which is what "the seeded surface
    /// rendered" actually means.
    private func waitForSeededTranscript(_ app: XCUIApplication) {
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "composer should render")
        // ANY fixture row, not a specific one. Which rows are materialized at
        // launch is device-dependent — an iPad renders the transcript wider, so
        // rows are shorter and the lazy stack materializes a different set than
        // an iPhone does. Naming one row here made this a device-specific
        // precondition rather than a check that the fixture seeded at all; the
        // tests scroll to the row they actually measure.
        let anyRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-fx-"))
            .firstMatch
        XCTAssertTrue(
            anyRow.waitForExistence(timeout: 30),
            "the fixture transcript should have seeded")
    }

    /// Seeds the fixture conversation into the REAL chat surface.
    /// `-uiTestFixtureRoute` cannot stand in: that route has no composer, and
    /// every assertion here needs a transcript and a composer sharing the
    /// screen.
    private func launchWithTranscript(appendAfterSeconds: Double? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestTranscriptFixture", "YES",
        ]
        if let appendAfterSeconds {
            app.launchArguments += [
                "-uiTestTranscriptAppendAfter", String(appendAfterSeconds),
            ]
        }
        app.launch()
        return app
    }
}
