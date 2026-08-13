import Foundation

/// The UI-free grammar behind the agent avatar's expression kit — the Swift
/// mirror of `packages/webcomponents/src/switcher/avatar-expression.ts`.
///
/// Every channel is a **point** (gaze), a **scalar** (socket corner radius, lid
/// fractions, brow raise/tilt) or an **event** (blink, pupil pop, glower,
/// scrutiny). That is what makes the two platforms mirrorable at all: SwiftUI
/// binds the same scalars the web animates as SVG attributes —
/// `RoundedRectangle(cornerRadius:)` for the socket morph, a `Rectangle` mask
/// offset for the chord-cut lids, `Capsule` + `rotationEffect` for the brows.
///
/// Arithmetic here works in the web's 200x100 eye-band units (eye radius 38,
/// pupil 18) so the constants stay literally identical to the TS module and can
/// be pinned by shared vectors. `SliccAgentAvatarGeometry.expressionScale`
/// converts them into the tile's points. Durations are seconds (the TS side
/// spells the same values in milliseconds).
///
/// Parity is enforced by `Fixtures/expression-vectors.json`, generated from the
/// TS module and asserted by BOTH suites — see `gen-expression-vectors.mjs`.
enum AvatarExpression {

    // MARK: - Channels

    /// What the agent is doing — the shape channel's only input.
    enum Activity: String, Equatable, Sendable, Codable, CaseIterable {
        case idle
        case thinking
        case working
        case awaiting
    }

    /// A gaze aim point in the 200x100 eye-band viewBox.
    struct GazePoint: Equatable, Sendable, Codable {
        var x: Double
        var y: Double
    }

    /// One brow capsule: how far it lifts, and how far it tips.
    struct BrowPose: Equatable, Sendable, Codable {
        /// Vertical offset in band units; negative lifts the brow off the eye.
        var raise: Double
        /// Rotation in degrees. On the LEFT brow a negative tilt raises its
        /// inner (right-hand) end — the mirror convention the web uses.
        var tilt: Double
    }

    struct BrowPair: Equatable, Sendable, Codable {
        var left: BrowPose
        var right: BrowPose
    }

    // MARK: - Band geometry

    static let eyeRadius = 38.0
    static let eyeCenterY = 50.0
    static let leftEyeX = 55.0
    static let rightEyeX = 145.0
    static let pupilRadius = 18.0
    static let maxOffset = 16.0

    // MARK: - Shape channel

    /// Socket corner radius at full square. A rect with `rx = r` IS a circle.
    static let socketMinRx = 10.0
    /// Pupil corner radius at full square, as a fraction of the pupil radius.
    static let pupilMinFraction = 0.22
    /// Shape integrator rate (per second). Blink-gated commits snap past it.
    static let shapeEase = 6.0

    // MARK: - Blink channel

    static let blinkInSeconds = 0.110
    static let blinkOutSeconds = 0.130
    /// The apex: lid fully down, the one moment a shape change may commit.
    static let blinkApexSeconds = 0.120
    static let blinkSquish = 0.08
    static let blinkPeriodLeftSeconds = 3.4
    static let blinkPeriodRightSeconds = 4.6

    // MARK: - Lid channel

    static let lidEase = 5.0
    /// Top lid on a failed tool call — reads angry, which is the point.
    static let glowerLid = 0.38
    static let glowerSeconds = 2.6
    /// Bottom lid while the user types — attention on what is being said.
    static let scrutinyLid = 0.22
    static let scrutinySeconds = 1.0
    static let drowseStartLid = 0.1
    static let drowseEndLid = 0.55
    static let drowseRampSeconds = 12.0
    static let defaultDrowseDelaySeconds = 90.0
    /// Below this the lid is treated as open and parked off the eye entirely.
    static let lidOpenEpsilon = 0.001
    /// Below this the chord line stays hidden (a 0-width line still paints a cap).
    static let lidLineEpsilon = 0.02
    /// How far past the socket an open lid parks, so the stroke survives.
    static let lidOvershoot = 3.0

    // MARK: - Pupil pop

    static let popSeconds = 0.35
    static let popGain = 0.16

    // MARK: - Brow channel

    static let browHalfWidth = 22.0
    static let browY = 2.0
    static let browStroke = 8.0
    static let browTransitionSeconds = 0.35
    /// Chance that a re-cock flips which brow is the raised one.
    static let recockFlipChance = 0.65
    /// The pose thinking opens with: left raised and quizzical, right settled.
    static let baseBrows = BrowPair(
        left: BrowPose(raise: -9, tilt: -10),
        right: BrowPose(raise: 2, tilt: 6))

    // MARK: - Gaze channel

    /// Up-and-away, the way a thinking creature looks past your shoulder.
    static let saccadeTargets: [GazePoint] = [
        GazePoint(x: 45, y: -15),
        GazePoint(x: 150, y: -10),
        GazePoint(x: 95, y: -25),
        GazePoint(x: 160, y: -30),
        GazePoint(x: 40, y: -28),
    ]
    static let saccadeIntervalSeconds = 1.3
    static let saccadeEase = 9.0

    /// Lower/mid region: alive, demanding nothing.
    static let wanderTargets: [GazePoint] = [
        GazePoint(x: 70, y: 60),
        GazePoint(x: 130, y: 40),
        GazePoint(x: 100, y: 72),
        GazePoint(x: 55, y: 30),
        GazePoint(x: 148, y: 62),
    ]
    static let wanderIntervalSeconds = 4.1
    static let wanderEase = 2.2
    static let anchorEase = 6.0

    /// Where `awaiting` looks with no anchor: slightly down of centre. On iOS
    /// there is no pointer and no composer element to aim at, so `awaiting`
    /// holds eye contact through the screen — see `AvatarExpressionEngine`.
    static let restGaze = GazePoint(x: 100, y: 66)

    // MARK: - Arithmetic

    static func lerp(_ from: Double, _ to: Double, _ t: Double) -> Double {
        from + (to - from) * t
    }

    /// One frame of exponential easing — the integrator every scalar uses.
    static func approach(
        current: Double, target: Double, rate: Double, dt: TimeInterval
    ) -> Double {
        current + (target - current) * min(1, rate * dt)
    }

    /// An absent activity means "no expression engine" (the legacy face), which
    /// is why this returns nil rather than defaulting. A present but
    /// unrecognised value reads as `idle` — the quietest treatment.
    static func parseActivity(_ raw: String?) -> Activity? {
        guard let raw else { return nil }
        return Activity(rawValue: raw) ?? .idle
    }

    /// Only tool work squares the eyes up; everything else rests as a circle.
    static func shapeTarget(for activity: Activity?) -> Double {
        activity == .working ? 1 : 0
    }

    static func socketRx(shape: Double) -> Double {
        lerp(eyeRadius, socketMinRx, shape)
    }

    static func pupilRx(radius: Double, shape: Double) -> Double {
        lerp(radius, radius * pupilMinFraction, shape)
    }

    /// Pupil radius for a fill percentage — the existing context-fill channel.
    static func fillToPupilScale(_ fill: Double?) -> Double {
        guard let fill else { return 1 }
        let clamped = min(100, max(0, fill))
        if clamped <= 50 { return 1 }
        if clamped >= 85 { return 2.2 }
        return 1 + ((clamped - 50) / 35) * 1.2
    }

    static func popScale(remaining: TimeInterval) -> Double {
        remaining <= 0 ? 1 : 1 + popGain * min(1, remaining / popSeconds)
    }

    /// Pupil travel stays clamped to a CIRCLE even in a square socket, so both
    /// platforms leave the corner room unused and agree exactly.
    static func travelClamp(pupilRadius: Double) -> Double {
        max(2, min(maxOffset, eyeRadius - pupilRadius - 4))
    }

    /// Y of the top-lid cut; an open lid parks the cut just off the socket.
    static func topLidY(fraction: Double) -> Double {
        fraction > lidOpenEpsilon
            ? eyeCenterY - eyeRadius + fraction * 2 * eyeRadius
            : eyeCenterY - eyeRadius - lidOvershoot
    }

    static func bottomLidY(fraction: Double) -> Double {
        fraction > lidOpenEpsilon
            ? eyeCenterY + eyeRadius - fraction * 2 * eyeRadius
            : eyeCenterY + eyeRadius + lidOvershoot
    }

    /// Half-width of the chord that closes the outline at a lid cut. It tracks
    /// the socket's current corner radius: circular sockets get the true chord,
    /// squared ones widen to the flat edge.
    static func chordHalfWidth(y: Double, shape: Double) -> Double {
        let dy = y - eyeCenterY
        let round = (max(0, eyeRadius * eyeRadius - dy * dy)).squareRoot()
        return lerp(round, eyeRadius - 2, shape)
    }

    /// The awaiting lid: a soft 10% on arrival, then a slow descent to 55%
    /// once the agent has been kept waiting past `delay`.
    static func drowseLid(awaiting: TimeInterval, delay: TimeInterval) -> Double {
        guard awaiting > delay else { return drowseStartLid }
        let t = min(1, (awaiting - delay) / drowseRampSeconds)
        return lerp(drowseStartLid, drowseEndLid, t)
    }

    static func isLeftRaised(_ pair: BrowPair) -> Bool {
        pair.left.raise < 0
    }

    /// The re-cock, committed at a blink apex: the raised side flips more often
    /// than not, and the constants re-jitter either way, so thinking gets a
    /// beat — hmm… (blink) …hmm?
    static func recockBrows(
        previous: BrowPair,
        random: () -> Double = { Double.random(in: 0..<1) }
    ) -> BrowPair {
        let leftRaised = random() < recockFlipChance ? !isLeftRaised(previous) : isLeftRaised(previous)
        let raised = BrowPose(raise: -(7 + random() * 5), tilt: 7 + random() * 5)
        let settled = BrowPose(raise: 1 + random() * 2, tilt: 4 + random() * 3)
        // The left brow mirrors: a negative tilt raises its inner end.
        return leftRaised
            ? BrowPair(left: BrowPose(raise: raised.raise, tilt: -raised.tilt), right: settled)
            : BrowPair(left: BrowPose(raise: settled.raise, tilt: -settled.tilt), right: raised)
    }

    /// Next auto-gaze index — never the current one, so every hop is visible.
    static func nextGazeIndex(current: Int, count: Int, random: () -> Double) -> Int {
        guard count >= 2 else { return 0 }
        return (current + 1 + Int(random() * Double(count - 1))) % count
    }
}
