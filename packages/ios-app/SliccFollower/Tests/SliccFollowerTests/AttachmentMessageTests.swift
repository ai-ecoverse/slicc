import UIKit
import XCTest

@testable import SliccFollower

/// Composer attachments (#1797): the wire shape on `user_message` and the
/// downscale-to-inline pipeline that mirrors `wc-attach.ts`.
final class AttachmentMessageTests: XCTestCase {

    private func makeImage(width: CGFloat, height: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(
            size: CGSize(width: width, height: height), format: format
        ).image { context in
            UIColor.systemPurple.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    // MARK: Wire

    func testUserMessageEncodesAttachments() throws {
        let attachment = MessageAttachment(
            id: "p1", name: "photo.jpg", mimeType: "image/jpeg", size: 4,
            kind: .image, data: "aGk=")
        let data = try JSONEncoder().encode(
            FollowerToLeaderMessage.userMessage(
                text: "look", messageId: "m1", attachments: [attachment]))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let list = try XCTUnwrap(json["attachments"] as? [[String: Any]])
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0]["data"] as? String, "aGk=")
        XCTAssertEqual(list[0]["kind"] as? String, "image")
    }

    func testUserMessageOmitsAbsentAttachments() throws {
        let data = try JSONEncoder().encode(
            FollowerToLeaderMessage.userMessage(text: "plain", messageId: "m2"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(
            json["attachments"],
            "optional on the wire: absent, not an empty array (web parity)")
    }

    func testUserMessageAttachmentsRoundTrip() throws {
        let original = FollowerToLeaderMessage.userMessage(
            text: "look", messageId: "m3",
            attachments: [
                MessageAttachment(
                    id: "p2", name: "photo.jpg", mimeType: "image/jpeg", size: 4,
                    kind: .image, data: "aGk=")
            ])
        let decoded = try JSONDecoder().decode(
            FollowerToLeaderMessage.self, from: JSONEncoder().encode(original))
        guard case .userMessage(_, _, _, let attachments) = decoded else {
            return XCTFail("decoded to the wrong case")
        }
        XCTAssertEqual(attachments?.first?.id, "p2")
        XCTAssertEqual(attachments?.first?.kind, .image)
    }

    // MARK: Downscale pipeline

    func testDownscaleCapsTheLongEdge() {
        let scaled = ImageAttachmentBuilder.downscale(
            makeImage(width: 4000, height: 2000), maxEdgePixels: 1568)
        XCTAssertEqual(scaled.size.width * scaled.scale, 1568, accuracy: 2)
        XCTAssertEqual(scaled.size.height * scaled.scale, 784, accuracy: 2)
    }

    func testDownscaleLeavesSmallImagesAlone() {
        let image = makeImage(width: 320, height: 200)
        let scaled = ImageAttachmentBuilder.downscale(image, maxEdgePixels: 1568)
        XCTAssertEqual(scaled.size.width * scaled.scale, 320, accuracy: 1)
    }

    func testInlineAttachmentEncodesJpegBase64() throws {
        let attachment = ImageAttachmentBuilder.inlineAttachment(
            from: makeImage(width: 2400, height: 1200), name: "photo.jpg")
        XCTAssertEqual(attachment.kind, .image)
        XCTAssertEqual(attachment.mimeType, "image/jpeg")
        XCTAssertEqual(attachment.name, "photo.jpg")
        XCTAssertNil(attachment.error)
        let bytes = try XCTUnwrap(Data(base64Encoded: XCTUnwrap(attachment.data)))
        XCTAssertEqual(attachment.size, bytes.count)
        let decoded = try XCTUnwrap(UIImage(data: bytes))
        XCTAssertLessThanOrEqual(
            max(decoded.size.width, decoded.size.height) * decoded.scale, 1570,
            "the encoded image respects INLINE_MAX_EDGE")
    }

    func testOversizeAfterDownscaleBecomesAnErrorAttachment() {
        let attachment = ImageAttachmentBuilder.inlineAttachment(
            from: makeImage(width: 2000, height: 2000), name: "big.jpg", maxBytes: 64)
        XCTAssertNotNil(attachment.error, "the ceiling surfaces as an error, not silence")
        XCTAssertNil(attachment.data, "no payload rides along with an error")
        XCTAssertEqual(attachment.kind, .image)
    }
}
