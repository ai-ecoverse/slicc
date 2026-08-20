import UserNotifications
import XCTest

@testable import SliccFollower

/// The notification category set is shared with the tray hub's APNs payloads
/// (`apns.ts` `APNS_CATEGORY_IDS`); pin the identifiers and the lock-screen
/// action policy: Deny is available without opening the app, Allow is not.
final class NotificationCategoriesTests: XCTestCase {
    func testCategoryIdentifiersMatchTheHub() {
        let ids = Set(makeSliccNotificationCategories().map(\.identifier))
        XCTAssertEqual(ids, ["SLICC_TURN_END", "SLICC_SUDO_REQUEST"])
    }

    func testSudoCategoryOffersDenyAndReviewOnly() throws {
        let sudo = try XCTUnwrap(
            makeSliccNotificationCategories().first { $0.identifier == "SLICC_SUDO_REQUEST" })
        let actions = Dictionary(uniqueKeysWithValues: sudo.actions.map { ($0.identifier, $0) })
        XCTAssertEqual(Set(actions.keys), ["SLICC_SUDO_DENY", "SLICC_SUDO_REVIEW"])
        XCTAssertTrue(actions["SLICC_SUDO_DENY"]!.options.contains(.destructive))
        XCTAssertFalse(actions["SLICC_SUDO_DENY"]!.options.contains(.foreground))
        XCTAssertTrue(actions["SLICC_SUDO_REVIEW"]!.options.contains(.foreground))
        XCTAssertFalse(actions.keys.contains { $0.contains("ALLOW") })
    }

    func testPayloadExtractionHandlesRemoteAndLocalShapes() {
        let remote = sliccNotificationPayload([
            "aps": ["alert": "x"],
            "slicc": ["category": "sudo_request", "requestId": "sudo-9", "trayId": "t"],
        ])
        XCTAssertEqual(remote.category, "sudo_request")
        XCTAssertEqual(remote.requestId, "sudo-9")
        let local = sliccNotificationPayload([
            SliccNotificationKey.category: "turn_end"
        ])
        XCTAssertEqual(local.category, "turn_end")
        XCTAssertNil(local.requestId)
    }
}
