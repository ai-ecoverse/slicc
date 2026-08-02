import XCTest

/// The dock's files surface (#1866) against the canned VFS tree.
final class FilesUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testBrowsesDirectoriesAndOpensAFile() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestOpenDockSurface", "files",
            "-uiTestFilesFixture", "YES",
        ]
        app.launch()

        let workspace = app.buttons["files-dir-workspace"]
        XCTAssertTrue(workspace.waitForExistence(timeout: 60), "the root listing renders")
        workspace.tap()

        let file = app.buttons["files-file-notes.txt"]
        XCTAssertTrue(file.waitForExistence(timeout: 10), "navigation descends directories")
        file.tap()

        XCTAssertTrue(
            app.buttons["files-share"].waitForExistence(timeout: 10),
            "an open file offers the system share sheet (Save to Files)")
        XCTAssertTrue(
            app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS 'fixture contents'")
            ).firstMatch.exists,
            "file contents preview inline")
    }
}
