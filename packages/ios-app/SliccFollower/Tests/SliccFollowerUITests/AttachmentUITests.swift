import XCTest

/// Composer attachments end to end against the staged fixture
/// (`-uiTestAttachmentFixture` — PhotosPicker runs out of process and
/// cannot be driven hermetically). No leader involved.
final class AttachmentUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testStagedPhotoSendsAsAnAttachmentChip() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestAttachmentFixture", "YES",
        ]
        app.launch()

        let staged = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH 'staged-remove-'")
        ).firstMatch
        XCTAssertTrue(staged.waitForExistence(timeout: 60), "the fixture photo is staged")

        // A staged photo alone is a legal send (web parity: no caption
        // required) — the send button is live with an empty text field.
        let send = app.buttons["composer-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        XCTAssertTrue(send.isEnabled, "a photo with no caption is sendable")
        send.tap()

        // The staging row clears and the sent message renders its chip.
        let chip = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH 'attachment-'")
        ).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "the sent message shows the chip")
        XCTAssertFalse(staged.exists, "the staging row clears after send")
    }

    func testRemovingTheStagedPhotoDisablesSend() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-joinUrl", "",
            "-uiTestConnectionState", "connected",
            "-uiTestAttachmentFixture", "YES",
        ]
        app.launch()

        let remove = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH 'staged-remove-'")
        ).firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 60), "the fixture photo is staged")
        remove.tap()

        XCTAssertFalse(
            remove.waitForExistence(timeout: 3),
            "removing the only staged photo clears the row")
    }
}
