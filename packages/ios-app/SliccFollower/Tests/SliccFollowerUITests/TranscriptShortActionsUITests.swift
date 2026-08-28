import XCTest

/// The transcript's short actions, end to end on the real chat
/// surface.
///
/// The unit suite proves WHICH spans become actionable; this proves the
/// gestures reach them, which is the half that only a running text engine can
/// answer — `TranscriptText` is a `UITextView` precisely because SwiftUI
/// `Text` has no per-span long press, and nothing below the view layer can
/// tell whether that wiring survived.
final class TranscriptShortActionsUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// Pre-formatted text carries the SAME native menu every other span does.
    ///
    /// This is the assertion that keeps the affordance consistent: the first
    /// version of this feature opened a SwiftUI `confirmationDialog` here,
    /// which put a centred alert card among six contextual menus. A menu that
    /// resolves to real `Copy`/`Share…` buttons can only come from the UIKit
    /// `UITextItem` menu — the same one the phone number and the link use.
    func testLongPressingInlineCodeOffersTheSameNativeMenu() {
        let app = launch()
        let body = paragraph(app, containing: "npm run build")
        XCTAssertTrue(body.waitForExistence(timeout: 10), "assistant paragraph renders")

        // The `code` run sits in the first line, right of centre.
        body.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.15))
            .press(forDuration: 1.2)

        XCTAssertTrue(
            app.buttons["Copy"].waitForExistence(timeout: 5),
            "Copy is offered for a long-pressed inline-code run")
        XCTAssertTrue(app.buttons["Share…"].exists, "so is Share")
        attach(app.screenshot(), named: "inline-code-menu")
    }

    /// A base64 blob is elided to a chip only once its bytes decode and are
    /// recognised, and the chip opens the same preview sheet a file does.
    func testTappingABase64ChipOpensThePreview() {
        let app = launch()
        let chips = payloadChips(app)
        XCTAssertTrue(chips.firstMatch.waitForExistence(timeout: 10), "payloads become chips")
        XCTAssertEqual(chips.count, 2, "one recognised image, one recognised text blob")

        chips.firstMatch.tap()
        // Quick Look, not a hand-rolled branch: a decoded payload gets the
        // same renderer the rest of the system uses, so a PNG zooms and a PDF
        // pages instead of arriving as a byte count.
        XCTAssertTrue(
            app.otherElements["file-preview-quicklook"].waitForExistence(timeout: 15),
            "a recognised payload previews through Quick Look")
        XCTAssertTrue(app.buttons["files-share"].exists, "and keeps the sheet's Share item")
        attach(app.screenshot(), named: "payload-preview")
    }

    /// The fixture's payloads are long enough to clear the floor; nothing
    /// shorter may be hidden, because eliding a run hides text the user wrote.
    func testTranscriptStillShowsTheProseAroundThePayloads() {
        let app = launch()
        XCTAssertTrue(paragraph(app, containing: "Here is the icon").waitForExistence(timeout: 10))
        XCTAssertTrue(paragraph(app, containing: "And the note itself").exists)
    }

    /// A rendered paragraph, by its accessibility LABEL.
    ///
    /// Which engine painted it is not this test's business, and must not be:
    /// `TranscriptTextView` reports `.staticText` and puts its contents in the
    /// label precisely so a paragraph looks the same to a query — and to
    /// VoiceOver — as the SwiftUI `Text` it replaced.
    private func paragraph(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// Matched on the label rather than `base64-chip`, because `MessageBubble`
    /// stamps `message-<id>` on the whole bubble and an ancestor identifier
    /// wins over a descendant's in the accessibility tree.
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
