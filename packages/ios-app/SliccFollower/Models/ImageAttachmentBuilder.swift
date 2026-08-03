import SliccTrayKit
import UIKit

/// Builds inline image attachments from picked, captured, or pasted photos,
/// mirroring the web composer's sizing rules (`wc-attach.ts`): long edge
/// capped at `INLINE_MAX_EDGE`, re-encoded JPEG, base64 into `data`.
///
/// A follower has no leader-side writer, so inline base64 is the only
/// variant this side ever produces (never `path`) — and the downscale is
/// not optional: a full-resolution phone photo would blow the 8 MiB tray
/// message ceiling that `__chunk` framing transports but does not raise.
enum ImageAttachmentBuilder {
    /// `INLINE_MAX_EDGE` (`wc-attach.ts`) — cap on the long edge in pixels.
    static let inlineMaxEdge: CGFloat = 1568
    /// `MAX_IMAGE_BYTES` (`wc-attach.ts`) — ceiling on the encoded bytes.
    static let maxImageBytes = 4 * 1024 * 1024
    static let jpegQuality: CGFloat = 0.85
    /// Budget for ALL staged attachments' base64 in one message, held
    /// safely under the 8 MiB tray ceiling (`TRAY_MAX_MESSAGE_BYTES`) so a
    /// multi-photo send can never assemble a message the transport must
    /// refuse.
    static let messageBase64Budget = 6 * 1024 * 1024

    /// Downscale + encode one image. Failures come back as an `error`
    /// attachment rather than nothing — the web behaves the same way, so
    /// the user sees why a photo did not reach the leader.
    static func inlineAttachment(
        from image: UIImage, name: String, maxBytes: Int = maxImageBytes,
        base64BudgetRemaining: Int = messageBase64Budget
    ) -> MessageAttachment {
        let scaled = downscale(image, maxEdgePixels: inlineMaxEdge)
        guard let jpeg = scaled.jpegData(compressionQuality: jpegQuality) else {
            return failed(name: name, reason: "The image could not be encoded.")
        }
        guard jpeg.count <= maxBytes else {
            return failed(
                name: name,
                reason: "The image is still over the size ceiling after downscaling.")
        }
        // Base64 expands 4/3: budget on the ENCODED footprint, since that is
        // what rides in the JSON the transport measures.
        guard (jpeg.count * 4) / 3 <= base64BudgetRemaining else {
            return failed(
                name: name,
                reason: "Attachments exceed the message size limit — remove one first.")
        }
        return MessageAttachment(
            id: UUID().uuidString,
            name: name,
            mimeType: "image/jpeg",
            size: jpeg.count,
            kind: .image,
            data: jpeg.base64EncodedString()
        )
    }

    /// Cap the long edge at `maxEdgePixels`, preserving aspect ratio.
    /// Renders at scale 1 so the output dimensions are literal pixels
    /// (`UIImage.size` is in points; the camera's 3x scale would otherwise
    /// triple the real edge).
    static func downscale(_ image: UIImage, maxEdgePixels: CGFloat) -> UIImage {
        let pixelWidth = image.size.width * image.scale
        let pixelHeight = image.size.height * image.scale
        let longEdge = max(pixelWidth, pixelHeight)
        guard longEdge > maxEdgePixels, longEdge > 0 else { return image }
        let ratio = maxEdgePixels / longEdge
        let target = CGSize(
            width: (pixelWidth * ratio).rounded(.down),
            height: (pixelHeight * ratio).rounded(.down))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    private static func failed(name: String, reason: String) -> MessageAttachment {
        MessageAttachment(
            id: UUID().uuidString,
            name: name,
            mimeType: "image/jpeg",
            size: 0,
            kind: .image,
            error: reason
        )
    }
}
