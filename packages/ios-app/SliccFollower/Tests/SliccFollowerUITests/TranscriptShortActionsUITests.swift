import UIKit
import XCTest

final class TranscriptShortActionsUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testLongPressingInlineCodeOffersTheSameNativeMenu() throws {
        let app = launch()
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10))
        if UIDevice.current.userInterfaceIdiom == .pad, window.frame.width > 560 {
            throw XCTSkip("Requires a compact-width simulator destination")
        }

        let body = paragraph(app, containing: "npm run build")
        XCTAssertTrue(body.waitForExistence(timeout: 10), "assistant paragraph renders")

        body.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.15))
            .press(forDuration: 1.2)

        XCTAssertTrue(
            app.buttons["Copy"].waitForExistence(timeout: 5),
            "Copy is offered for a long-pressed inline-code run")
        XCTAssertTrue(app.buttons["Share…"].exists, "so is Share")
        attach(app.screenshot(), named: "inline-code-menu")
    }

    func testTappingABase64ChipOpensThePreview() {
        let app = launch()
        let chips = payloadChips(app)
        XCTAssertTrue(chips.firstMatch.waitForExistence(timeout: 10), "payloads become chips")
        XCTAssertEqual(chips.count, 2, "one recognised image, one recognised text blob")

        chips.firstMatch.tap()

        XCTAssertTrue(
            app.otherElements["file-preview-quicklook"].waitForExistence(timeout: 15),
            "a recognised payload previews through Quick Look")
        XCTAssertTrue(app.buttons["files-share"].exists, "and keeps the sheet's Share item")
        attach(app.screenshot(), named: "payload-preview")
    }

    func testTranscriptStillShowsTheProseAroundThePayloads() {
        let app = launch()
        XCTAssertTrue(paragraph(app, containing: "Here is the icon").waitForExistence(timeout: 10))
        XCTAssertTrue(paragraph(app, containing: "And the note itself").exists)
    }

    private func paragraph(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func payloadChips(_ app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Double tap to preview"))
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "", "-uiTestConnectionState", "connected",
            "-uiTestShortActionsFixture", "YES",
            "-uiTestReduceMotion", "YES",
        ]
        app.launch()
        return app
    }

    private func attach(_ screenshot: XCUIScreenshot, named name: String) {
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
