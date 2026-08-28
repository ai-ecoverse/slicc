import AppKit
import CryptoKit
import SwiftUI
import XCTest

/// Rendering helpers for the launcher's SwiftUI surfaces.
///
/// A lot of this app's behavior lives in view bodies — which sections appear
/// for a given scan, which row is disabled without a leader, what the update
/// footer says, whether an unreachable iCloud session is dimmed. `ImageRenderer`
/// evaluates a real `body` off-screen (no window, no run loop), so a test can
/// drive every one of those states and assert on what came out.
///
/// Two things it deliberately does **not** try to do:
///
/// - **Press buttons.** Headless SwiftUI on macOS builds no AppKit control tree
///   and no accessibility tree (both are lazy, and the latter only materializes
///   for an attached assistive client), so `NSHostingView` yields a bare
///   `_FocusRingView` and `accessibilityChildren()` is empty. Button *actions*
///   are therefore tested through the plain types they delegate to
///   (`AppListActions`, `TerminalLaunchDecision`, …), not through the view.
///   `TraySessionRow`'s `.borderless` buttons are the exception that does
///   materialize as `NSButton`s — see `hostedButtons`.
/// - **Assert on pixels.** The comparison helpers only ask whether two states
///   render the *same* or *differently*, which is stable across machines and
///   OS versions in a way a golden image is not.
enum ViewHosting {

    /// Force one full `body` evaluation and return the rendered bitmap.
    @MainActor
    static func render(_ view: some View, width: CGFloat = 520, height: CGFloat = 640) -> NSImage? {
        let renderer = ImageRenderer(content: view.frame(width: width, height: height))
        renderer.scale = 1
        return renderer.nsImage
    }

    /// Render a view and fail the test if it produced nothing. Returns a stable
    /// digest of the bitmap so two states can be compared.
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

    /// Assert two states of the same view do not render identically — i.e. the
    /// state actually reaches the screen instead of being computed and dropped.
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

    // MARK: - AppKit-backed controls

    /// Lay a view out off-screen and return the AppKit controls it produced.
    /// Only bordered/borderless button styles materialize as `NSButton`s; a
    /// `.plain` button does not (see the note above).
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
