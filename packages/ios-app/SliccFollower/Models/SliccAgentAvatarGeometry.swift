import Foundation
import SliccTrayKit

struct SliccAgentAvatarGeometry: Equatable, Sendable {
    enum AvatarType: Equatable, Sendable {
        case cone
        case scoop
    }

    enum EyeState: Equatable, Sendable {
        case open
        case dead
        case none
        case `static`
    }

    static let noiseCellSize = 1.0
    static let noiseFramesPerSecond = 12.0
    static let noiseOpacity = 0.72
    static let noiseLuminance = [0.08, 0.36, 0.68, 0.94]
    static let frozenNoiseSeed: UInt32 = 0x51CC_A11E
    static let noiseFrameSalt: UInt32 = 0x9E37_79B9
    static let noiseEyeSalt: UInt32 = 0x85EB_CA6B

    struct Point: Equatable, Sendable {
        let x: Double
        let y: Double
    }

    let type: AvatarType
    let color: String
    let eyes: EyeState
    let fill: Double?
    let blink: Bool
    let sideLength: Double

    let activity: AvatarExpression.Activity?

    init(
        type: AvatarType, color: String, eyes: EyeState = .open, fill: Double? = nil,
        blink: Bool = false, sideLength: Double = 26,
        activity: AvatarExpression.Activity? = nil
    ) {
        self.type = type
        self.color = color
        self.eyes = eyes
        self.fill = fill.map { min(100, max(0, $0)) }
        self.blink = blink
        self.sideLength = max(0, sideLength)
        self.activity = activity
    }

    private struct BandPlacement {

        let left: Double
        let top: Double
        let width: Double
        let height: Double

        let zoom: Double

        var unit: Double { zoom * min(width / 200, height / 100) }

        func place(x bandX: Double, y bandY: Double) -> Point {
            let fit = min(width / 200, height / 100)
            let originX = left + (width - 200 * fit) / 2
            let originY = top + (height - 100 * fit) / 2
            let translateX = 0.5 - zoom * (left + width / 2)
            let translateY = 0.5 - zoom * (top + height / 2)
            return Point(
                x: zoom * (originX + bandX * fit) + translateX,
                y: zoom * (originY + bandY * fit) + translateY)
        }
    }

    private var placement: BandPlacement {
        switch type {
        case .scoop: .init(left: 0.15, top: 0.30, width: 0.70, height: 0.45, zoom: 2.65)
        case .cone: .init(left: 0.17, top: -0.185, width: 0.70, height: 0.44, zoom: 3)
        }
    }

    private var bandUnit: Double { placement.unit * sideLength }

    var tileCornerRadius: Double { 0.269 * sideLength }
    var eyeRadius: Double { AvatarExpression.eyeRadius * bandUnit }
    var eyeOutlineWidth: Double { Self.bandStrokeWidth * bandUnit }
    var eyeDiameter: Double { eyeRadius * 2 }
    var eyeCenters: [Point] {
        [AvatarExpression.leftEyeX, AvatarExpression.rightEyeX].map { bandX in
            let placed = placement.place(x: bandX, y: AvatarExpression.eyeCenterY)
            return Point(x: placed.x * sideLength, y: placed.y * sideLength)
        }
    }

    static let bandStrokeWidth = 4.0

    var pupilRadius: Double {
        AvatarExpression.pupilRadius * bandUnit * Self.fillScale(for: fill)
    }
    var highlightRadius: Double { 0.4 * pupilRadius }
    var highlightOffset: Point {
        Point(x: -0.3 * pupilRadius, y: -0.35 * pupilRadius)
    }

    var maxPupilTravel: Double {
        let unclamped = eyeRadius - pupilRadius - eyeOutlineWidth
        return min(AvatarExpression.maxOffset * bandUnit, max(2 * bandUnit, unclamped))
    }

    func clampedPupilOffset(_ proposed: Point) -> Point {
        let distance = hypot(proposed.x, proposed.y)
        guard distance > maxPupilTravel, distance > 0 else { return proposed }
        let scale = maxPupilTravel / distance
        return Point(x: proposed.x * scale, y: proposed.y * scale)
    }

    static func fillScale(for fill: Double?) -> Double {
        AvatarExpression.fillToPupilScale(fill)
    }

    var expressionScale: Double { eyeRadius / AvatarExpression.eyeRadius }

    func socketCornerRadius(shape: Double) -> Double {
        AvatarExpression.socketRx(shape: shape) * expressionScale
    }

    func pupilCornerRadius(shape: Double, radius: Double) -> Double {
        AvatarExpression.pupilRx(radius: radius, shape: shape)
    }

    func lidInset(fraction: Double) -> Double {
        max(0, min(1, fraction)) * eyeDiameter
    }

    func browCenter(eyeIndex: Int, raise: Double) -> Point {
        let bandX = eyeIndex == 0 ? AvatarExpression.leftEyeX : AvatarExpression.rightEyeX
        let placed = placement.place(x: bandX, y: AvatarExpression.browY + raise)
        return Point(x: placed.x * sideLength, y: placed.y * sideLength)
    }

    var browSize: Point {
        Point(
            x: AvatarExpression.browHalfWidth * 2 * bandUnit,
            y: AvatarExpression.browStroke * bandUnit)
    }

    func chordHalfWidth(fraction: Double, shape: Double, edge: LidEdge) -> Double {
        let y =
            edge == .top
            ? AvatarExpression.topLidY(fraction: fraction)
            : AvatarExpression.bottomLidY(fraction: fraction)
        return AvatarExpression.chordHalfWidth(y: y, shape: shape) * expressionScale
    }

    enum LidEdge: Equatable, Sendable {
        case top
        case bottom
    }

    var deadCrossHalfSpan: Double { eyeRadius * (15.0 / 38.0) }
    var deadCrossLineWidth: Double { eyeOutlineWidth * 2 }

    var glyphCenter: Point {
        switch type {
        case .cone: Point(x: 0.5 * sideLength, y: 0.83 * sideLength)
        case .scoop: Point(x: 0.5 * sideLength, y: 0.64 * sideLength)
        }
    }

    var glyphSize: Point {
        switch type {
        case .cone: Point(x: 1.84 * sideLength, y: 0.68 * sideLength)
        case .scoop: Point(x: 1.8 * sideLength, y: 1.45 * sideLength)
        }
    }
}

extension ScoopSummary {
    func avatarGeometry(
        sideLength: Double = 26,
        eyesOverride: SliccAgentAvatarGeometry.EyeState? = nil,
        activity: AvatarExpression.Activity? = nil
    ) -> SliccAgentAvatarGeometry {
        let type: SliccAgentAvatarGeometry.AvatarType = isRootUnit ? .cone : .scoop
        let scoopStatus = status
        let lifecycleEyes: SliccAgentAvatarGeometry.EyeState =
            switch scoopStatus.lifecycle {
            case .broken: .dead
            case .initializing: .none
            case .working, .idle, .unknown: .open
            }
        return .init(
            type: type, color: avatarColor, eyes: eyesOverride ?? lifecycleEyes,
            fill: scoopStatus.fullness,
            blink: scoopStatus.lifecycle == .working,
            sideLength: sideLength,
            activity: activity)
    }

    struct LocalExpressionSignals: Equatable, Sendable {

        var toolRunning: Bool

        var awaitingUser: Bool

        init(toolRunning: Bool = false, awaitingUser: Bool = false) {
            self.toolRunning = toolRunning
            self.awaitingUser = awaitingUser
        }
    }

    func avatarActivity(local: LocalExpressionSignals? = nil) -> AvatarExpression.Activity? {

        let refinement = ScoopActivity(activity: activity)
        switch status.lifecycle {

        case .broken, .initializing:
            return nil
        case .working:
            if let local { return local.toolRunning ? .working : .thinking }

            return refinement == .tool ? .working : .thinking
        case .idle, .unknown:
            if local?.awaitingUser == true { return .awaiting }
            return refinement == .awaiting ? .awaiting : .idle
        }
    }

    private var avatarColor: String {
        if isRootUnit { return "#b07823" }
        let palette = ["#06b6d4", "#8b5cf6", "#f59e0b", "#10b981", "#3b82f6", "#ef4444"]
        let hash = name.unicodeScalars.reduce(UInt32.zero) { hash, scalar in
            let firstCodeUnit: UInt32 =
                scalar.value <= 0xFFFF
                ? scalar.value
                : 0xD800 + ((scalar.value - 0x10000) >> 10)
            return hash &* 31 &+ firstCodeUnit
        }
        return palette[Int(hash % UInt32(palette.count))]
    }
}
