import SliccTrayKit
import UIKit









enum ImageAttachmentBuilder {
    
    static let inlineMaxEdge: CGFloat = 1568
    
    static let maxImageBytes = 4 * 1024 * 1024
    static let jpegQuality: CGFloat = 0.85
    
    
    
    
    static let messageBase64Budget = 6 * 1024 * 1024

    
    
    
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
