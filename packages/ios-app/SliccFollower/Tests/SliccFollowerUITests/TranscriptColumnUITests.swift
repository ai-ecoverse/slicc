import XCTest










final class TranscriptColumnUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    
    
    
    
    
    
    
    
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

        
        
        let timestamp = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "2024")
        ).firstMatch
        XCTAssertTrue(timestamp.waitForExistence(timeout: 30), "the transcript rendered")

        let columnCenter = timestamp.frame.midX
        let containerCenter = title.frame.midX
        XCTAssertEqual(
            columnCenter, containerCenter, accuracy: 4,
            "the reading column must be centered in the conversation, not pinned to an edge")

        
        
        let assistantText = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Extracted the install steps")
        ).firstMatch
        XCTAssertTrue(assistantText.waitForExistence(timeout: 30))
        XCTAssertGreaterThan(
            assistantText.frame.minX, 24,
            "the capped column leaves a real gutter at regular width")
    }
}
