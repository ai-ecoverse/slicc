import CoreGraphics
import Foundation












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

    
    var scale: CGSize {
        CGSize(
            width: pointSize.width > 0 ? pixelSize.width / pointSize.width : 1,
            height: pointSize.height > 0 ? pixelSize.height / pointSize.height : 1)
    }

    
    func globalPoint(fromPixel pixel: CGPoint) -> CGPoint {
        let scale = self.scale
        let sx = scale.width > 0 ? scale.width : 1
        let sy = scale.height > 0 ? scale.height : 1
        return CGPoint(x: origin.x + pixel.x / sx, y: origin.y + pixel.y / sy)
    }

    
    func globalDelta(fromPixel pixel: CGPoint) -> CGPoint {
        let point = globalPoint(fromPixel: pixel)
        return CGPoint(x: point.x - origin.x, y: point.y - origin.y)
    }

    
    var summary: String {
        "\(Int(pixelSize.width.rounded()))x\(Int(pixelSize.height.rounded()))"
            + (isMain ? " (main)" : "")
    }

    
    
    static func identity(size: CGSize) -> ComputerDisplayGeometry {
        ComputerDisplayGeometry(
            displayID: 0, origin: .zero, pointSize: size, pixelSize: size, isMain: true)
    }
}








enum ComputerDisplaySelection {
    static func ordered(
        _ displays: [ComputerDisplayGeometry], activeOrder: [CGDirectDisplayID]
    ) -> [ComputerDisplayGeometry] {
        var rank: [CGDirectDisplayID: Int] = [:]
        for (index, id) in activeOrder.enumerated() where rank[id] == nil { rank[id] = index }
        
        
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
