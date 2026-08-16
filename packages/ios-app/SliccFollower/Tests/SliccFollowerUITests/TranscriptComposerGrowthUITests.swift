import XCTest

/// Reproduction for #2072: the transcript throws the reader backwards through
/// the history when the keyboard's inset lands.
///
/// **This documents an open iOS 26 SwiftUI bug (FB20979569), not ours.**
/// `ScrollView` + `LazyVStack` + dynamic-height rows mis-restores its position
/// when the container resizes. It is skipped by default because it asserts
/// behaviour the platform does not currently provide — running it green is the
/// goal, not the status quo.
///
/// Run it deliberately:
///
/// ```bash
/// SLICC_REPRO_2072=1 xcodebuild test \
///   -only-testing:SliccFollowerUITests/TranscriptComposerGrowthUITests …
/// ```
///
/// Re-check it whenever the Xcode/simulator SDK moves: the day this passes
/// unmodified, Apple has fixed the bug and the skip can go.
final class TranscriptComposerGrowthUITests: XCTestCase {

    /// How far a row may move while the composer and keyboard claim their
    /// space. Sliding up by the height the viewport loses is legitimate;
    /// jumping backwards through the conversation is not. The measured
    /// regression moves a row by +453pt against a ~301pt inset, so this sits
    /// well below the bug and above the honest shift.
    private let allowedDrift: CGFloat = 120

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testHistoryStaysPutWhenTheComposerAndKeyboardClaimSpace() throws {
        try XCTSkipIf(
            ProcessInfo.processInfo.environment["SLICC_REPRO_2072"] == nil,
            "Reproduces #2072, an open iOS 26 SwiftUI bug (FB20979569). "
                + "Set SLICC_REPRO_2072=1 to run it.")

        let app = launchWithTranscript()

        let anchor = app.descendants(matching: .any)
            .matching(identifier: "message-fx-delegation-1").firstMatch
        XCTAssertTrue(anchor.waitForExistence(timeout: 60), "fixture transcript should render")

        // The scroll is load-bearing. Until the reader drags, the transcript's
        // `ScrollPosition` still holds the programmatic `edge: .bottom` from
        // `scrollToBottom()`, which SwiftUI re-pins for free when the viewport
        // shrinks — four reproduction attempts came back clean for exactly
        // this reason. Only once the position is the reader's does the resize
        // have to restore it, which is the path that fails.
        anchor.swipeDown()
        let afterScroll = anchor.frame.midY

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))

        // One character first: the keyboard's inset is applied on the next
        // render pass rather than when the keyboard appears, so the first
        // keystroke is what lands it — and that is the larger of the two jumps.
        composer.typeText("x")
        XCTAssertLessThan(
            abs(anchor.frame.midY - afterScroll), allowedDrift,
            "the keyboard's inset threw the reader through the history "
                + "(moved \(anchor.frame.midY - afterScroll)pt)")

        composer.typeText(" and now a great deal more text that wraps onto four separate lines")
        XCTAssertLessThan(
            abs(anchor.frame.midY - afterScroll), allowedDrift,
            "growing the composer threw the reader through the history "
                + "(moved \(anchor.frame.midY - afterScroll)pt)")
    }

    /// Seeds the fixture conversation into the REAL chat surface.
    /// `-uiTestFixtureRoute` cannot stand in: it has no composer, and this
    /// needs a transcript and a composer sharing the screen.
    private func launchWithTranscript() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestTranscriptFixture", "YES",
        ]
        app.launch()
        return app
    }
}
