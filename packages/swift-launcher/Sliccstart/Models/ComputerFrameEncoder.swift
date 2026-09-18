import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct ComputerEncodedFrame {
    let data: Data
    let width: Int
    let height: Int
    let nativeWidth: Int
    let nativeHeight: Int
}


enum ComputerFrameEncoder {
    static let defaultQuality: CGFloat = 0.7

    static func jpeg(
        from image: CGImage,
        maxWidth: Int?,
        quality: CGFloat = defaultQuality
    ) -> ComputerEncodedFrame? {
        let nativeWidth = image.width
        let nativeHeight = image.height
        let scaled = scale(image, maxWidth: maxWidth) ?? image
        guard let data = jpegData(scaled, quality: quality) else { return nil }
        return ComputerEncodedFrame(
            data: data,
            width: scaled.width,
            height: scaled.height,
            nativeWidth: nativeWidth,
            nativeHeight: nativeHeight
        )
    }

    static func scale(_ image: CGImage, maxWidth: Int?) -> CGImage? {
        guard let maxWidth, maxWidth > 0, image.width > maxWidth else { return image }
        let ratio = Double(maxWidth) / Double(image.width)
        let height = max(1, Int((Double(image.height) * ratio).rounded()))
        guard
            let colorSpace = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
            let ctx = CGContext(
                data: nil,
                width: maxWidth,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: maxWidth, height: height))
        return ctx.makeImage()
    }

    static func jpegData(_ image: CGImage, quality: CGFloat) -> Data? {
        let data = NSMutableData()
        guard
            let dest = CGImageDestinationCreateWithData(
                data, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImage(dest, image, options as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }
}
