import CoreGraphics
import Foundation

/// One attached display in the three coordinate spaces the native computer path
/// has to reconcile:
///
/// - `SCDisplay.width`/`.height` are **points**;
/// - the wire's `nativeWidth`/`nativeHeight` are **pixels**, so `native` means
///   the same thing here as it does for a tab computer (#3380);
/// - `CGEvent` posts in **points** in a global space whose origin is the *main*
///   display's top-left, which the captured display need not be (#3379/#3385).
///
/// `origin` is negative for a display left of or above the main one, so nothing
/// downstream may assume a non-negative offset.
struct ComputerDisplayGeometry: Equatable {
    var displayID: CGDirectDisplayID
    var origin: CGPoint
    var pointSize: CGSize
    var pixelSize: CGSize
    var isMain: Bool

    init(
        displayID: CGDirectDisplayID,
        origin: CGPoint,
        pointSize: CGSize,
        pixelSize: CGSize? = nil,
        isMain: Bool = false
    ) {
        self.displayID = displayID
        self.origin = origin
        self.pointSize = pointSize
        let pixels = pixelSize ?? pointSize
        self.pixelSize =
            pixels.width > 0 && pixels.height > 0 ? pixels : pointSize
        self.isMain = isMain
    }

    /// Pixels per point per axis — 1 on a non-Retina display, 2 on a Studio Display.
    var scale: CGSize {
        CGSize(
            width: pointSize.width > 0 ? pixelSize.width / pointSize.width : 1,
            height: pointSize.height > 0 ? pixelSize.height / pointSize.height : 1)
    }

    /// A point in this display's native pixels → the global point `CGEvent` posts at.
    func globalPoint(fromPixel pixel: CGPoint) -> CGPoint {
        let scale = self.scale
        let sx = scale.width > 0 ? scale.width : 1
        let sy = scale.height > 0 ? scale.height : 1
        return CGPoint(x: origin.x + pixel.x / sx, y: origin.y + pixel.y / sy)
    }

    /// A native-pixel offset → the same offset in global points.
    func globalDelta(fromPixel pixel: CGPoint) -> CGPoint {
        let point = globalPoint(fromPixel: pixel)
        return CGPoint(x: point.x - origin.x, y: point.y - origin.y)
    }

    /// `2880x5120 (main)` — the operator-facing shorthand in a display listing.
    var summary: String {
        "\(Int(pixelSize.width.rounded()))x\(Int(pixelSize.height.rounded()))"
            + (isMain ? " (main)" : "")
    }

    /// An identity stand-in for callers that only have a size: zero origin and
    /// scale 1, i.e. exactly the pre-#3385 behaviour.
    static func identity(size: CGSize) -> ComputerDisplayGeometry {
        ComputerDisplayGeometry(
            displayID: 0, origin: .zero, pointSize: size, pixelSize: size, isMain: true)
    }
}

/// Which display native capture uses, and how an operator names another one.
///
/// The index is 1-based in the OS active-display order — the same order and
/// numbering `screencapture -D <n>` uses — so a choice can be cross-checked with
/// a shell one-liner on the follower. `SCShareableContent.displays` order is
/// unspecified and on a four-display Mac Studio returns a *secondary* display
/// first, so it decides neither the default nor the numbering (#3379).
enum ComputerDisplaySelection {
    static func ordered(
        _ displays: [ComputerDisplayGeometry], activeOrder: [CGDirectDisplayID]
    ) -> [ComputerDisplayGeometry] {
        var rank: [CGDirectDisplayID: Int] = [:]
        for (index, id) in activeOrder.enumerated() where rank[id] == nil { rank[id] = index }
        // Displays absent from the active list sort last in discovery order, so
        // the numbering stays stable rather than shuffling under the operator.
        return displays.enumerated()
            .sorted { left, right in
                let lhs = rank[left.element.displayID] ?? Int.max
                let rhs = rank[right.element.displayID] ?? Int.max
                return lhs == rhs ? left.offset < right.offset : lhs < rhs
            }
            .map(\.element)
    }

    static func pick(
        from displays: [ComputerDisplayGeometry],
        activeOrder: [CGDirectDisplayID],
        index: Int?
    ) throws -> ComputerDisplayGeometry {
        let ordered = ordered(displays, activeOrder: activeOrder)
        guard !ordered.isEmpty else { throw ComputerCaptureError.noDisplay }
        guard let index else { return ordered.first(where: \.isMain) ?? ordered[0] }
        guard index >= 1, index <= ordered.count else {
            throw ComputerCaptureError.displayOutOfRange(
                index: index, available: summary(ordered))
        }
        return ordered[index - 1]
    }

    static func summary(_ ordered: [ComputerDisplayGeometry]) -> String {
        ordered.enumerated()
            .map { "\($0.offset + 1)=\($0.element.summary)" }
            .joined(separator: ", ")
    }
}
