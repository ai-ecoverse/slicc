import Foundation

enum AvatarExpression {

    enum Activity: String, Equatable, Sendable, Codable, CaseIterable {
        case idle
        case thinking
        case working
        case awaiting
    }

    struct GazePoint: Equatable, Sendable, Codable {
        var x: Double
        var y: Double
    }

    struct BrowPose: Equatable, Sendable, Codable {

        var raise: Double

        var tilt: Double
    }

    struct BrowPair: Equatable, Sendable, Codable {
        var left: BrowPose
        var right: BrowPose
    }

    static let eyeRadius = 38.0
    static let eyeCenterY = 50.0
    static let leftEyeX = 55.0
    static let rightEyeX = 145.0
    static let pupilRadius = 18.0
    static let maxOffset = 16.0

    static let socketMinRx = 10.0

    static let pupilMinFraction = 0.22

    static let shapeEase = 6.0

    static let blinkInSeconds = 0.110
    static let blinkOutSeconds = 0.130

    static let blinkApexSeconds = 0.120
    static let blinkSquish = 0.08
    static let blinkPeriodLeftSeconds = 3.4
    static let blinkPeriodRightSeconds = 4.6

    static let lidEase = 5.0

    static let glowerLid = 0.38
    static let glowerSeconds = 2.6

    static let scrutinyLid = 0.22
    static let scrutinySeconds = 1.0
    static let drowseStartLid = 0.1
    static let drowseEndLid = 0.55
    static let drowseRampSeconds = 12.0
    static let defaultDrowseDelaySeconds = 90.0

    static let lidOpenEpsilon = 0.001

    static let lidLineEpsilon = 0.02

    static let lidOvershoot = 3.0

    static let popSeconds = 0.35
    static let popGain = 0.16

    static let browHalfWidth = 22.0
    static let browY = 2.0
    static let browStroke = 8.0
    static let browTransitionSeconds = 0.35

    static let recockFlipChance = 0.65

    static let baseBrows = BrowPair(
        left: BrowPose(raise: -9, tilt: -10),
        right: BrowPose(raise: 2, tilt: 6))

    static let saccadeTargets: [GazePoint] = [
        GazePoint(x: 45, y: -15),
        GazePoint(x: 150, y: -10),
        GazePoint(x: 95, y: -25),
        GazePoint(x: 160, y: -30),
        GazePoint(x: 40, y: -28),
    ]
    static let saccadeIntervalSeconds = 1.3
    static let saccadeEase = 9.0

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

    static let restGaze = GazePoint(x: 100, y: 66)

    static func lerp(_ from: Double, _ to: Double, _ t: Double) -> Double {
        from + (to - from) * t
    }

    static func approach(
        current: Double, target: Double, rate: Double, dt: TimeInterval
    ) -> Double {
        current + (target - current) * min(1, rate * dt)
    }

    static func parseActivity(_ raw: String?) -> Activity? {
        guard let raw else { return nil }
        return Activity(rawValue: raw) ?? .idle
    }

    static func shapeTarget(for activity: Activity?) -> Double {
        activity == .working ? 1 : 0
    }

    static func socketRx(shape: Double) -> Double {
        lerp(eyeRadius, socketMinRx, shape)
    }

    static func pupilRx(radius: Double, shape: Double) -> Double {
        lerp(radius, radius * pupilMinFraction, shape)
    }

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

    static func travelClamp(pupilRadius: Double) -> Double {
        max(2, min(maxOffset, eyeRadius - pupilRadius - 4))
    }

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

    static func chordHalfWidth(y: Double, shape: Double) -> Double {
        let dy = y - eyeCenterY
        let round = (max(0, eyeRadius * eyeRadius - dy * dy)).squareRoot()
        return lerp(round, eyeRadius - 2, shape)
    }

    static func drowseLid(awaiting: TimeInterval, delay: TimeInterval) -> Double {
        guard awaiting > delay else { return drowseStartLid }
        let t = min(1, (awaiting - delay) / drowseRampSeconds)
        return lerp(drowseStartLid, drowseEndLid, t)
    }

    static func isLeftRaised(_ pair: BrowPair) -> Bool {
        pair.left.raise < 0
    }

    static func recockBrows(
        previous: BrowPair,
        random: () -> Double = { Double.random(in: 0..<1) }
    ) -> BrowPair {
        let leftRaised = random() < recockFlipChance ? !isLeftRaised(previous) : isLeftRaised(previous)
        let raised = BrowPose(raise: -(7 + random() * 5), tilt: 7 + random() * 5)
        let settled = BrowPose(raise: 1 + random() * 2, tilt: 4 + random() * 3)

        return leftRaised
            ? BrowPair(left: BrowPose(raise: raised.raise, tilt: -raised.tilt), right: settled)
            : BrowPair(left: BrowPose(raise: settled.raise, tilt: -settled.tilt), right: raised)
    }

    static func nextGazeIndex(current: Int, count: Int, random: () -> Double) -> Int {
        guard count >= 2 else { return 0 }
        return (current + 1 + Int(random() * Double(count - 1))) % count
    }
}
