import AppKit
import CryptoKit
import SwiftUI
import XCTest

enum ViewHosting {

    @MainActor
    static func render(_ view: some View, width: CGFloat = 520, height: CGFloat = 640) -> NSImage? {
        let renderer = ImageRenderer(content: view.frame(width: width, height: height))
        renderer.scale = 1
        return renderer.nsImage
    }

    @MainActor
    @discardableResult
    static func digest(
        of view: some View,
        width: CGFloat = 520,
        height: CGFloat = 640,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> String {
        guard let image = render(view, width: width, height: height) else {
            XCTFail("view produced no rendering", file: file, line: line)
            return ""
        }
        guard
            let tiff = image.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff),
            let png = bitmap.representation(using: .png, properties: [:])
        else {
            XCTFail("rendered image could not be encoded", file: file, line: line)
            return ""
        }
        XCTAssertGreaterThan(png.count, 0, "rendered an empty image", file: file, line: line)
        return SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
    }

    @MainActor
    static func assertRendersDifferently(
        _ lhs: some View,
        _ rhs: some View,
        _ message: @autoclosure () -> String = "the two states render identically",
        width: CGFloat = 520,
        height: CGFloat = 640,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let left = digest(of: lhs, width: width, height: height, file: file, line: line)
        let right = digest(of: rhs, width: width, height: height, file: file, line: line)
        XCTAssertNotEqual(left, right, message(), file: file, line: line)
    }

    @MainActor
    static func hostedButtons(_ view: some View, width: CGFloat = 420, height: CGFloat = 60)
        -> [NSButton]
    {
        let host = NSHostingView(rootView: AnyView(view.frame(width: width, height: height)))
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.layoutSubtreeIfNeeded()
        return descendants(of: host).compactMap { $0 as? NSButton }
    }

    @MainActor
    static func descendants(of view: NSView) -> [NSView] {
        view.subviews + view.subviews.flatMap(descendants(of:))
    }
}
