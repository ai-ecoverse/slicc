import XCTest

/// Regression cover for the iPad reading column.
///
/// #1938 capped the transcript at `MessageListLayout.maximumReadableWidth`, but
/// the capped column rendered flush against the leading edge — the cap is only
/// half the requirement, and an uncentered reading column just strands the
/// trailing third of the window. The cause was structural rather than cosmetic:
/// the centering frames wrapped the `LazyVStack` that carries
/// `scrollTargetLayout()`, and the scroll view anchors on that target layout, so
/// it cancelled the centering offset with an equal content offset.
final class TranscriptColumnUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Run on an iPad simulator: at regular width the transcript must sit in a
    /// centered reading column, not hug the leading edge.
    ///
    /// Both anchors are centered in the same container — the navigation title
    /// centers in the conversation column, and a transcript timestamp header
    /// centers in the reading column — so their center lines coincide exactly
    /// when the column is centered, and diverge by half the leftover width when
    /// it is not. That keeps the assertion independent of the dock rail's width.
    func testRegularWidthTranscriptColumnIsCentered() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestFixtureRoute", "YES"]
        app.launch()

        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10))
        guard UIDevice.current.userInterfaceIdiom == .pad, window.frame.width > 560 else {
            throw XCTSkip("Requires a regular-width iPad simulator destination")
        }

        let title = app.navigationBars.staticTexts["UI Fixture"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 30), "the fixture route opened")

        // The fixture's clock is pinned to 2024, so every timestamp header
        // carries the year no matter which locale the simulator runs in.
        let timestamp = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "2024")
        ).firstMatch
        XCTAssertTrue(timestamp.waitForExistence(timeout: 30), "the transcript rendered")

        let columnCenter = timestamp.frame.midX
        let containerCenter = title.frame.midX
        XCTAssertEqual(
            columnCenter, containerCenter, accuracy: 4,
            "the reading column must be centered in the conversation, not pinned to an edge")

        // A column that silently stopped being capped would also centre, so
        // hold the other half of #1938 as well.
        let assistantText = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Extracted the install steps")
        ).firstMatch
        XCTAssertTrue(assistantText.waitForExistence(timeout: 30))
        XCTAssertGreaterThan(
            assistantText.frame.minX, 24,
            "the capped column leaves a real gutter at regular width")
    }
}
