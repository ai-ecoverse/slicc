import Foundation
import SliccTrayKit

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
    /// The expression channel. `nil` keeps the legacy face — no lids, no brows,
    /// no engine — exactly like a `<slicc-agent-avatar>` with no `activity`
    /// attribute, so every existing surface is untouched until it opts in.
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

    /// How `slicc-agent-avatar.ts` lands the 200x100 eye band on the tile, per
    /// avatar type. The web positions `.eyes` at `top/left/width/height` inside
    /// `.icon-inner`, which then carries `translate(--tx,--ty) scale(--zoom)`;
    /// the SVG itself meets its box. Both types share the same band unit, so
    /// the ONLY thing that differs is the zoom and where the band sits — and
    /// the cone zooms harder (3 vs 2.65) into a band pulled above the tile.
    /// Hard-coding the scoop's numbers for both is what left cone eyes too
    /// small and too far inboard.
    private struct BandPlacement {
        /// `TYPE.<type>.eyes`, as fractions of the tile side.
        let left: Double
        let top: Double
        let width: Double
        let height: Double
        /// `TYPE.<type>.zoom`.
        let zoom: Double

        /// One 200x100 band unit as a fraction of the tile side, after the SVG's
        /// `xMidYMid meet` fit and the `icon-inner` zoom.
        var unit: Double { zoom * min(width / 200, height / 100) }

        /// Tile-space position of a band point, as fractions of the tile side.
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

    /// An exhaustive `switch`, not a lookup table: a third avatar type has to
    /// declare where its band lands rather than silently inheriting the
    /// scoop's, which is the failure this whole property exists to undo.
    private var placement: BandPlacement {
        switch type {
        case .scoop: .init(left: 0.15, top: 0.30, width: 0.70, height: 0.45, zoom: 2.65)
        case .cone: .init(left: 0.17, top: -0.185, width: 0.70, height: 0.44, zoom: 3)
        }
    }

    /// One 200x100 band unit in points.
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

    /// The socket/lid stroke, `stroke-width: 4` in band units on the web side.
    static let bandStrokeWidth = 4.0

    var pupilRadius: Double {
        AvatarExpression.pupilRadius * bandUnit * Self.fillScale(for: fill)
    }
    var highlightRadius: Double { 0.4 * pupilRadius }
    var highlightOffset: Point {
        Point(x: -0.3 * pupilRadius, y: -0.35 * pupilRadius)
    }

    /// Radial travel available to device tilt, clamped exactly like the web avatar.
    var maxPupilTravel: Double {
        let unclamped = eyeRadius - pupilRadius - eyeOutlineWidth
        return min(AvatarExpression.maxOffset * bandUnit, max(2 * bandUnit, unclamped))
    }

    /// Applies the web avatar's radial max-offset clamp to a proposed pupil offset.
    func clampedPupilOffset(_ proposed: Point) -> Point {
        let distance = hypot(proposed.x, proposed.y)
        guard distance > maxPupilTravel, distance > 0 else { return proposed }
        let scale = maxPupilTravel / distance
        return Point(x: proposed.x * scale, y: proposed.y * scale)
    }

    static func fillScale(for fill: Double?) -> Double {
        AvatarExpression.fillToPupilScale(fill)
    }

    /// Band units → points. The expression grammar works in the web's 200x100
    /// eye-band units (eye radius 38) so its constants stay literally identical
    /// across the two implementations; the tile's own ratios above are
    /// hand-rounded for the crop, so this factor — and not those ratios — is
    /// the bridge. One multiply keeps every expression scalar in step.
    var expressionScale: Double { eyeRadius / AvatarExpression.eyeRadius }

    /// Socket corner radius for a shape scalar: the circle→rounded-square morph.
    func socketCornerRadius(shape: Double) -> Double {
        AvatarExpression.socketRx(shape: shape) * expressionScale
    }

    /// Pupil corner radius for a shape scalar. `pupilRx` is linear in the
    /// radius, so a point-space radius comes back in point space.
    func pupilCornerRadius(shape: Double, radius: Double) -> Double {
        AvatarExpression.pupilRx(radius: radius, shape: shape)
    }

    /// How far a lid cut has descended into the eye, in points.
    func lidInset(fraction: Double) -> Double {
        max(0, min(1, fraction)) * eyeDiameter
    }

    /// A brow capsule's centre, in tile points.
    ///
    /// Band space, exactly like the web's `.brow-layer`: centred on its eye's
    /// `cx`, sitting at `browY`, with `raise` in band units — no inward pull
    /// and no headroom budget. The band is bigger than the tile, so a brow
    /// OVERHANGS the roundrect; the view paints it outside the crop instead of
    /// squeezing it in (`SliccAgentAvatarView.layers`).
    func browCenter(eyeIndex: Int, raise: Double) -> Point {
        let bandX = eyeIndex == 0 ? AvatarExpression.leftEyeX : AvatarExpression.rightEyeX
        let placed = placement.place(x: bandX, y: AvatarExpression.browY + raise)
        return Point(x: placed.x * sideLength, y: placed.y * sideLength)
    }

    /// The brow capsule itself: the band's stroke, laid on its side.
    var browSize: Point {
        Point(
            x: AvatarExpression.browHalfWidth * 2 * bandUnit,
            y: AvatarExpression.browStroke * bandUnit)
    }

    /// Half-width of the chord line that closes the outline at a lid cut.
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
        let type: SliccAgentAvatarGeometry.AvatarType = isCone ? .cone : .scoop
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

    /// Signals the follower observed for itself, from streams it is already
    /// mirroring. Only available for the scoop whose transcript is on screen.
    struct LocalExpressionSignals: Equatable, Sendable {
        /// A tool call is in flight (`tool_use_start` seen, no `tool_result` yet).
        var toolRunning: Bool
        /// The turn settled and the composer is the user's.
        var awaitingUser: Bool

        init(toolRunning: Bool = false, awaitingUser: Bool = false) {
            self.toolRunning = toolRunning
            self.awaitingUser = awaitingUser
        }
    }

    /// The expression channel for this scoop.
    ///
    /// **Precedence: local derivation > wire state > unknown.** Pass `local`
    /// for the focused scoop — the follower brackets `tool_use_start` /
    /// `tool_result` and the turn settle itself, which is both richer and a
    /// broadcast earlier than the leader's next `scoops.list`. Omit it for the
    /// tabs and tiles whose streams this follower is not watching: the wire's
    /// `activity` refinement then supplies what local observation cannot.
    ///
    /// `state` still decides busy-vs-idle in BOTH modes, which is what keeps a
    /// leader that predates the refinement working: it says `working` with no
    /// `activity`, and the absence of a local tool bracket makes that
    /// `thinking` — exactly as this follower behaved before.
    func avatarActivity(local: LocalExpressionSignals? = nil) -> AvatarExpression.Activity? {
        // An unrecognised refinement decodes to nil and the lifecycle alone
        // decides — the same escape hatch the browser follower applies.
        let refinement = ScoopActivity(activity: activity)
        switch status.lifecycle {
        // Broken and initializing keep their own eye treatments (dead / none),
        // so they carry no activity at all.
        case .broken, .initializing:
            return nil
        case .working:
            if let local { return local.toolRunning ? .working : .thinking }
            // No refinement (an older leader's bare `working`) reads as
            // thinking, exactly as this follower rendered it before.
            return refinement == .tool ? .working : .thinking
        case .idle, .unknown:
            if local?.awaitingUser == true { return .awaiting }
            return refinement == .awaiting ? .awaiting : .idle
        }
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
