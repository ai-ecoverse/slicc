import Foundation

/// View-independent inputs and geometry for the googly-eyed agent tile.
/// Ratios mirror `slicc-agent-avatar.ts`; the SwiftUI view only paints them.
struct SliccAgentAvatarGeometry: Equatable, Sendable {
    enum AvatarType: Equatable, Sendable {
        case cone
        case scoop
    }

    enum EyeState: Equatable, Sendable {
        case open
        case dead
        case none
    }

    struct Point: Equatable, Sendable {
        let x: Double
        let y: Double
    }

    let type: AvatarType
    let color: String
    let eyes: EyeState
    let fill: Double
    let blink: Bool
    let sideLength: Double

    init(
        type: AvatarType, color: String, eyes: EyeState = .open, fill: Double = 0,
        blink: Bool = false, sideLength: Double = 26
    ) {
        self.type = type
        self.color = color
        self.eyes = eyes
        self.fill = min(100, max(0, fill))
        self.blink = blink
        self.sideLength = max(0, sideLength)
    }

    var tileCornerRadius: Double { 0.269 * sideLength }
    var eyeRadius: Double { 0.352 * sideLength }
    var eyeOutlineWidth: Double { 0.037 * sideLength }
    var eyeDiameter: Double { eyeRadius * 2 }
    var eyeCenters: [Point] {
        [
            Point(x: 0.083 * sideLength, y: 0.5 * sideLength),
            Point(x: 0.917 * sideLength, y: 0.5 * sideLength),
        ]
    }

    var pupilRadius: Double { 0.167 * sideLength * Self.fillScale(for: fill) }
    var highlightRadius: Double { 0.4 * pupilRadius }
    var highlightOffset: Point {
        Point(x: -0.3 * pupilRadius, y: -0.35 * pupilRadius)
    }

    /// Radial travel available to device tilt, clamped exactly like the web avatar.
    var maxPupilTravel: Double {
        let unclamped = eyeRadius - pupilRadius - eyeOutlineWidth
        return min(0.148 * sideLength, max(0.019 * sideLength, unclamped))
    }

    /// Applies the web avatar's radial max-offset clamp to a proposed pupil offset.
    func clampedPupilOffset(_ proposed: Point) -> Point {
        let distance = hypot(proposed.x, proposed.y)
        guard distance > maxPupilTravel, distance > 0 else { return proposed }
        let scale = maxPupilTravel / distance
        return Point(x: proposed.x * scale, y: proposed.y * scale)
    }

    static func fillScale(for fill: Double) -> Double {
        let clampedFill = min(100, max(0, fill))
        if clampedFill <= 50 { return 1 }
        if clampedFill >= 85 { return 2.2 }
        return 1 + ((clampedFill - 50) / 35) * 1.2
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
    func avatarGeometry(sideLength: Double = 26) -> SliccAgentAvatarGeometry {
        let type: SliccAgentAvatarGeometry.AvatarType = isCone ? .cone : .scoop
        let state = state ?? "idle"
        let eyes: SliccAgentAvatarGeometry.EyeState
        switch state {
        case "broken": eyes = .dead
        case "initializing": eyes = .none
        default: eyes = .open
        }
        return .init(
            type: type, color: avatarColor, eyes: eyes, fill: fill ?? 0,
            blink: state == "working", sideLength: sideLength)
    }

    /// Mirrors `scoopColor`: JS iterates scalars, while `charCodeAt(0)` deliberately
    /// hashes only each scalar's first UTF-16 unit (dropping an astral low surrogate).
    private var avatarColor: String {
        if isCone { return "#b07823" }
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
