import UIKit
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

    /// `XCUIDevice.orientation` persists across test cases in a run, and a
    /// `defer` inside a test does not reliably fire when `continueAfterFailure
    /// = false` raises. Without this, a landscape test leaves every later case
    /// rotated — which is how an unrelated portrait test started failing at the
    /// same line as the landscape one.
    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    // MARK: - #2072

    func testHistoryStaysPutWhenTheComposerAndKeyboardClaimSpace() throws {
        try assertHistoryStaysPut(orientation: .portrait)
    }

    /// Landscape is not redundant on an iPad: the transcript is wider (so rows
    /// are shorter and the lazy stack materializes a different set) and the
    /// keyboard claims a much larger fraction of the viewport, which is the
    /// resize that #2072 mishandled.
    func testHistoryStaysPutInLandscape() throws {
        // iPad only, and said out loud rather than quietly skipped. A phone in
        // landscape with the keyboard up leaves a transcript viewport barely
        // taller than one fixture row, so there is no reading position to
        // centre the anchor in and the precondition — not the fix — is what
        // fails. The drift gate still runs on a phone in portrait, which is
        // the case #2072 was reported against.
        try XCTSkipUnless(
            UIDevice.current.userInterfaceIdiom == .pad,
            "landscape drift is measured on iPad; a phone's landscape "
                + "transcript is too short to hold a centred reading position")
        try assertHistoryStaysPut(orientation: .landscapeLeft)
    }

    private func assertHistoryStaysPut(orientation: UIDeviceOrientation) throws {
        let app = launchWithTranscript()
        XCUIDevice.shared.orientation = orientation
        Thread.sleep(forTimeInterval: 1.5)

        let anchor = app.descendants(matching: .any)
            .matching(identifier: anchorId).firstMatch
        waitForSeededTranscript(app)

        // Scrolling back is load-bearing. Until the reader drags, the
        // transcript is still pinned to the bottom by its own anchor, and a
        // viewport that shrinks against a bottom pin is re-pinned for free.
        // Only once the position is the *reader's* does the resize have to
        // preserve it, and that is the path #2072 broke.
        scrollBackUntilAnchorIsCentred(app: app, anchor: anchor)
        let afterScroll = anchor.frame.midY
        attach(app, name: "1-after-reader-scroll-\(orientation.rawValue)")

        let composer = focusedComposer(app)
        // The inset can land a render pass after the keyboard reports itself
        // present, so settle before sampling — reading in between shows
        // "focus changes nothing", which is what killed two earlier
        // hypotheses.
        Thread.sleep(forTimeInterval: 1.5)
        let afterKeyboard = anchor.frame.midY
        attach(app, name: "2-keyboard-up-\(orientation.rawValue)")
        report("keyboard", orientation: orientation, drift: afterKeyboard - afterScroll)
        XCTAssertLessThan(
            abs(afterKeyboard - afterScroll), allowedDrift,
            "the keyboard's inset threw the reader through the history "
                + "(moved \(afterKeyboard - afterScroll)pt)")

        type("x", into: composer, app: app)
        Thread.sleep(forTimeInterval: 0.5)
        report("first keystroke", orientation: orientation, drift: anchor.frame.midY - afterScroll)
        XCTAssertLessThan(
            abs(anchor.frame.midY - afterScroll), allowedDrift,
            "the first keystroke threw the reader through the history "
                + "(moved \(anchor.frame.midY - afterScroll)pt)")

        type(
            " and now a great deal more text that wraps onto four separate lines",
            into: composer, app: app)
        Thread.sleep(forTimeInterval: 0.5)
        attach(app, name: "3-composer-grown-\(orientation.rawValue)")
        report("composer growth", orientation: orientation, drift: anchor.frame.midY - afterScroll)
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
        // `isHittable` is fine HERE and not in `scrollBackUntilAnchorIsCentred`:
        // this is an assertion, where a raise is an acceptable way to fail, not
        // a loop guard whose job is to decide whether to keep scrolling.
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

    /// Prints the measured drift so a run reports the NUMBER, not just a
    /// verdict. The whole point of #2072 was a quantity; a green tick that
    /// hides it is how the regression got mis-attributed for weeks.
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

    /// Taps the composer and waits for the keyboard before returning it.
    ///
    /// An empty composer mounts `PttPressSurface` **over** the editor and
    /// hit-disables it (hold-to-talk), so the tap reaches the press surface and
    /// focus arrives a beat later through its `quickTap` event.
    private func focusedComposer(_ app: XCUIApplication) -> XCUIElement {
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "composer should exist")
        composer.tap()
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 10),
            "tapping the composer should raise the keyboard")
        return composer
    }

    /// Waits for the fixture to have seeded.
    ///
    /// ANY fixture row, not a specific one. Which rows are materialized at
    /// launch is device-dependent — an iPad renders the transcript wider, so
    /// rows are shorter and the lazy stack materializes a different set than an
    /// iPhone does. Naming one row made this a device-specific precondition
    /// rather than a check that the fixture seeded at all; the tests scroll to
    /// the row they actually measure.
    private func waitForSeededTranscript(_ app: XCUIApplication) {
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "composer should render")
        let anyRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "message-fx-"))
            .firstMatch
        XCTAssertTrue(
            anyRow.waitForExistence(timeout: 30),
            "the fixture transcript should have seeded")
    }

    private func report(_ step: String, orientation: UIDeviceOrientation, drift: CGFloat) {
        let side = orientation == .portrait ? "portrait" : "landscape"
        print("DRIFT \(side) after \(step): \(drift)pt")
    }

    /// Screenshot attachment, kept only when the test fails.
    private func attach(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .deleteOnSuccess
        add(shot)
    }

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
        // Normalized, so the proportions survive a rotation.
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.20))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))

        // The acceptance window is a FRACTION of the viewport, not a fixed
        // point range. `y > 150 && y < 650` was tuned on a portrait iPad and
        // cannot be satisfied on a phone in landscape at all — the screen is
        // ~390pt tall, so most of that window is off-screen and the loop can
        // never converge.
        let viewport = app.windows.firstMatch.frame
        let lowerBound = viewport.height * 0.20
        let upperBound = viewport.height * 0.72

        for _ in 0..<20 {
            // Deliberately NOT `isHittable`. It raises "Failed to determine
            // hittability … activation point invalid" when a row has a
            // degenerate frame, which is precisely the state this loop exists
            // to scroll out of — the guard added to dodge one throw introduced
            // another. `exists` plus a non-degenerate frame answers the same
            // question without asking XCUITest to compute an activation point.
            if anchor.exists {
                let frame = anchor.frame
                if frame.height > 0, frame.midY > lowerBound, frame.midY < upperBound { break }
            }
            // `.slow` matters: a flung drag travels unpredictably and
            // oscillates past the window, so a fast drag can miss 20 times.
            top.press(
                forDuration: 0.1, thenDragTo: bottom, withVelocity: .slow,
                thenHoldForDuration: 0)
        }
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertTrue(
            anchor.exists && anchor.frame.height > 0,
            "anchor row should be on screen to measure against")
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
