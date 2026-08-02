import XCTest

/// The dock's memory surface (#1867) against the canned fixture.
final class MemoryUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testMemoryRendersTaggedRows() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestOpenDockSurface", "memory",
            "-uiTestMemoryFixture", "YES",
        ]
        app.launch()

        XCTAssertTrue(
            app.staticTexts["Prefers concise answers with code examples over prose."]
                .waitForExistence(timeout: 60),
            "memory bullets render as rows")
        XCTAssertTrue(
            app.staticTexts["feedback"].exists,
            "section names classify rows (feedback tag from Corrections)")
    }
}
