import XCTest

@testable import SliccFollower

/// Cross-implementation parity for the agent-avatar expression kit: every
/// vector in Fixtures/expression-vectors.json (generated from the canonical TS
/// grammar by gen-expression-vectors.mjs) must reproduce through the Swift
/// port. The webcomponents suite asserts the same file, so the two renderers of
/// one grammar cannot drift apart silently.
///
/// The expression kit is the one place where a quiet numeric divergence would
/// not fail anything else: both platforms would keep rendering a plausible
/// face, just not the SAME face.
final class AvatarExpressionVectorTests: XCTestCase {
    private let accuracy = 0.000_000_001

    // MARK: - Fixture shape

    private struct Vectors: Decodable {
        let constants: Constants
        let saccadeTargets: [AvatarExpression.GazePoint]
        let wanderTargets: [AvatarExpression.GazePoint]
        let restGaze: AvatarExpression.GazePoint
        let baseBrows: AvatarExpression.BrowPair
        let socketRx: [SocketRx]
        let pupilRx: [PupilRx]
        let fillToPupilScale: [FillScale]
        let travelClamp: [TravelClamp]
        let lidY: [LidY]
        let chordHalfWidth: [Chord]
        let drowseLid: [Drowse]
        let popScale: [Pop]
        let approach: [Approach]
        let shapeTarget: [ShapeTarget]
        let parseActivity: [ParseActivity]
        let recockBrows: [Recock]
        let nextGazeIndex: [GazeIndex]
    }

    private struct Constants: Decodable {
        let eyeRadius: Double
        let eyeCenterY: Double
        let leftEyeX: Double
        let rightEyeX: Double
        let pupilRadius: Double
        let maxOffset: Double
        let socketMinRx: Double
        let pupilMinFraction: Double
        let shapeEase: Double
        let lidEase: Double
        let glowerLid: Double
        let glowerSeconds: Double
        let scrutinyLid: Double
        let scrutinySeconds: Double
        let drowseStartLid: Double
        let drowseEndLid: Double
        let drowseRampSeconds: Double
        let defaultDrowseDelaySeconds: Double
        let popSeconds: Double
        let popGain: Double
        let blinkApexSeconds: Double
        let blinkSquish: Double
        let browHalfWidth: Double
        let browY: Double
        let browStroke: Double
        let recockFlipChance: Double
        let saccadeIntervalSeconds: Double
        let saccadeEase: Double
        let wanderIntervalSeconds: Double
        let wanderEase: Double
        let anchorEase: Double
        let lidOvershoot: Double
        let lidLineEpsilon: Double
    }

    private struct SocketRx: Decodable {
        let shape: Double
        let expected: Double
    }

    private struct PupilRx: Decodable {
        let radius: Double
        let shape: Double
        let expected: Double
    }

    private struct FillScale: Decodable {
        let fill: Double
        let expected: Double
    }

    private struct TravelClamp: Decodable {
        let pupilRadius: Double
        let expected: Double
    }

    private struct LidY: Decodable {
        let fraction: Double
        let top: Double
        let bottom: Double
    }

    private struct Chord: Decodable {
        let fraction: Double
        let shape: Double
        let edge: String
        let expected: Double
    }

    private struct Drowse: Decodable {
        let awaitingSeconds: Double
        let delaySeconds: Double
        let expected: Double
    }

    private struct Pop: Decodable {
        let remainingSeconds: Double
        let expected: Double
    }

    private struct Approach: Decodable {
        let current: Double
        let target: Double
        let rate: Double
        let dt: Double
        let expected: Double
    }

    private struct ShapeTarget: Decodable {
        let activity: String?
        let expected: Double
    }

    private struct ParseActivity: Decodable {
        let raw: String
        let expected: String?
    }

    private struct Recock: Decodable {
        let name: String
        let randoms: [Double]
        let previous: AvatarExpression.BrowPair
        let expected: AvatarExpression.BrowPair
    }

    private struct GazeIndex: Decodable {
        let current: Int
        let count: Int
        let random: Double
        let expected: Int
    }

    private func loadVectors() throws -> Vectors {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "expression-vectors", withExtension: "json"),
            "expression-vectors.json missing from the test bundle")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    /// A deterministic stand-in for `Double.random` that walks a fixed sequence.
    private func sequence(_ values: [Double]) -> () -> Double {
        var index = 0
        return {
            defer { index += 1 }
            return values[index % values.count]
        }
    }

    private func drift(_ name: String) -> String {
        "\(name) diverged — regenerate with gen-expression-vectors.mjs and fix whichever side changed"
    }

    // MARK: - Tests

    func testSharedConstantsMatch() throws {
        let c = try loadVectors().constants

        XCTAssertEqual(AvatarExpression.eyeRadius, c.eyeRadius, drift("eyeRadius"))
        XCTAssertEqual(AvatarExpression.eyeCenterY, c.eyeCenterY, drift("eyeCenterY"))
        XCTAssertEqual(AvatarExpression.leftEyeX, c.leftEyeX, drift("leftEyeX"))
        XCTAssertEqual(AvatarExpression.rightEyeX, c.rightEyeX, drift("rightEyeX"))
        XCTAssertEqual(AvatarExpression.pupilRadius, c.pupilRadius, drift("pupilRadius"))
        XCTAssertEqual(AvatarExpression.maxOffset, c.maxOffset, drift("maxOffset"))
        XCTAssertEqual(AvatarExpression.socketMinRx, c.socketMinRx, drift("socketMinRx"))
        XCTAssertEqual(
            AvatarExpression.pupilMinFraction, c.pupilMinFraction, drift("pupilMinFraction"))
        XCTAssertEqual(AvatarExpression.shapeEase, c.shapeEase, drift("shapeEase"))
        XCTAssertEqual(AvatarExpression.lidEase, c.lidEase, drift("lidEase"))
        XCTAssertEqual(AvatarExpression.glowerLid, c.glowerLid, drift("glowerLid"))
        XCTAssertEqual(AvatarExpression.glowerSeconds, c.glowerSeconds, drift("glowerSeconds"))
        XCTAssertEqual(AvatarExpression.scrutinyLid, c.scrutinyLid, drift("scrutinyLid"))
        XCTAssertEqual(
            AvatarExpression.scrutinySeconds, c.scrutinySeconds, drift("scrutinySeconds"))
        XCTAssertEqual(AvatarExpression.drowseStartLid, c.drowseStartLid, drift("drowseStartLid"))
        XCTAssertEqual(AvatarExpression.drowseEndLid, c.drowseEndLid, drift("drowseEndLid"))
        XCTAssertEqual(
            AvatarExpression.drowseRampSeconds, c.drowseRampSeconds, drift("drowseRampSeconds"))
        XCTAssertEqual(
            AvatarExpression.defaultDrowseDelaySeconds, c.defaultDrowseDelaySeconds,
            drift("defaultDrowseDelaySeconds"))
        XCTAssertEqual(AvatarExpression.popSeconds, c.popSeconds, drift("popSeconds"))
        XCTAssertEqual(AvatarExpression.popGain, c.popGain, drift("popGain"))
        XCTAssertEqual(
            AvatarExpression.blinkApexSeconds, c.blinkApexSeconds, drift("blinkApexSeconds"))
        XCTAssertEqual(AvatarExpression.blinkSquish, c.blinkSquish, drift("blinkSquish"))
        XCTAssertEqual(AvatarExpression.browHalfWidth, c.browHalfWidth, drift("browHalfWidth"))
        XCTAssertEqual(AvatarExpression.browY, c.browY, drift("browY"))
        XCTAssertEqual(AvatarExpression.browStroke, c.browStroke, drift("browStroke"))
        XCTAssertEqual(
            AvatarExpression.recockFlipChance, c.recockFlipChance, drift("recockFlipChance"))
        XCTAssertEqual(
            AvatarExpression.saccadeIntervalSeconds, c.saccadeIntervalSeconds,
            drift("saccadeIntervalSeconds"))
        XCTAssertEqual(AvatarExpression.saccadeEase, c.saccadeEase, drift("saccadeEase"))
        XCTAssertEqual(
            AvatarExpression.wanderIntervalSeconds, c.wanderIntervalSeconds,
            drift("wanderIntervalSeconds"))
        XCTAssertEqual(AvatarExpression.wanderEase, c.wanderEase, drift("wanderEase"))
        XCTAssertEqual(AvatarExpression.anchorEase, c.anchorEase, drift("anchorEase"))
        XCTAssertEqual(AvatarExpression.lidOvershoot, c.lidOvershoot, drift("lidOvershoot"))
        XCTAssertEqual(AvatarExpression.lidLineEpsilon, c.lidLineEpsilon, drift("lidLineEpsilon"))
    }

    func testGazeTablesAndRestingPosesMatch() throws {
        let vectors = try loadVectors()

        XCTAssertEqual(AvatarExpression.saccadeTargets, vectors.saccadeTargets, drift("saccades"))
        XCTAssertEqual(AvatarExpression.wanderTargets, vectors.wanderTargets, drift("wander"))
        XCTAssertEqual(AvatarExpression.restGaze, vectors.restGaze, drift("restGaze"))
        XCTAssertEqual(AvatarExpression.baseBrows, vectors.baseBrows, drift("baseBrows"))
    }

    func testShapeChannelVectorsReproduce() throws {
        let vectors = try loadVectors()
        XCTAssertGreaterThanOrEqual(vectors.socketRx.count, 5)

        for vector in vectors.socketRx {
            XCTAssertEqual(
                AvatarExpression.socketRx(shape: vector.shape), vector.expected,
                accuracy: accuracy, drift("socketRx(\(vector.shape))"))
        }
        for vector in vectors.pupilRx {
            XCTAssertEqual(
                AvatarExpression.pupilRx(radius: vector.radius, shape: vector.shape),
                vector.expected, accuracy: accuracy,
                drift("pupilRx(\(vector.radius), \(vector.shape))"))
        }
        for vector in vectors.shapeTarget {
            let activity = vector.activity.flatMap(AvatarExpression.Activity.init(rawValue:))
            XCTAssertEqual(
                AvatarExpression.shapeTarget(for: activity), vector.expected,
                drift("shapeTarget(\(vector.activity ?? "nil"))"))
        }
    }

    func testFillAndTravelVectorsReproduce() throws {
        let vectors = try loadVectors()

        for vector in vectors.fillToPupilScale {
            XCTAssertEqual(
                AvatarExpression.fillToPupilScale(vector.fill), vector.expected,
                accuracy: accuracy, drift("fillToPupilScale(\(vector.fill))"))
            // The shipped tile helper must keep agreeing with the grammar.
            XCTAssertEqual(
                SliccAgentAvatarGeometry.fillScale(for: vector.fill), vector.expected,
                accuracy: accuracy, drift("fillScale(for: \(vector.fill))"))
        }
        for vector in vectors.travelClamp {
            XCTAssertEqual(
                AvatarExpression.travelClamp(pupilRadius: vector.pupilRadius), vector.expected,
                accuracy: accuracy, drift("travelClamp(\(vector.pupilRadius))"))
        }
    }

    func testLidAndChordVectorsReproduce() throws {
        let vectors = try loadVectors()
        XCTAssertGreaterThanOrEqual(vectors.chordHalfWidth.count, 30)

        for vector in vectors.lidY {
            XCTAssertEqual(
                AvatarExpression.topLidY(fraction: vector.fraction), vector.top,
                accuracy: accuracy, drift("topLidY(\(vector.fraction))"))
            XCTAssertEqual(
                AvatarExpression.bottomLidY(fraction: vector.fraction), vector.bottom,
                accuracy: accuracy, drift("bottomLidY(\(vector.fraction))"))
        }
        for vector in vectors.chordHalfWidth {
            let y =
                vector.edge == "top"
                ? AvatarExpression.topLidY(fraction: vector.fraction)
                : AvatarExpression.bottomLidY(fraction: vector.fraction)
            XCTAssertEqual(
                AvatarExpression.chordHalfWidth(y: y, shape: vector.shape), vector.expected,
                accuracy: accuracy,
                drift("chordHalfWidth(\(vector.edge) \(vector.fraction) @ \(vector.shape))"))
        }
    }

    func testDrowsePopAndEasingVectorsReproduce() throws {
        let vectors = try loadVectors()

        for vector in vectors.drowseLid {
            XCTAssertEqual(
                AvatarExpression.drowseLid(
                    awaiting: vector.awaitingSeconds, delay: vector.delaySeconds),
                vector.expected, accuracy: accuracy,
                drift("drowseLid(\(vector.awaitingSeconds), \(vector.delaySeconds))"))
        }
        for vector in vectors.popScale {
            XCTAssertEqual(
                AvatarExpression.popScale(remaining: vector.remainingSeconds), vector.expected,
                accuracy: accuracy, drift("popScale(\(vector.remainingSeconds))"))
        }
        for vector in vectors.approach {
            XCTAssertEqual(
                AvatarExpression.approach(
                    current: vector.current, target: vector.target, rate: vector.rate,
                    dt: vector.dt),
                vector.expected, accuracy: accuracy, drift("approach"))
        }
    }

    func testBrowRecockAndGazeIndexVectorsReproduce() throws {
        let vectors = try loadVectors()

        for vector in vectors.recockBrows {
            XCTAssertEqual(
                AvatarExpression.recockBrows(
                    previous: vector.previous, random: sequence(vector.randoms)),
                vector.expected, drift("recockBrows(\(vector.name))"))
        }
        for vector in vectors.nextGazeIndex {
            XCTAssertEqual(
                AvatarExpression.nextGazeIndex(
                    current: vector.current, count: vector.count, random: { vector.random }),
                vector.expected,
                drift("nextGazeIndex(\(vector.current), \(vector.count), \(vector.random))"))
        }
    }

    func testActivityParsingVectorsReproduce() throws {
        for vector in try loadVectors().parseActivity {
            XCTAssertEqual(
                AvatarExpression.parseActivity(vector.raw)?.rawValue, vector.expected,
                drift("parseActivity(\(vector.raw))"))
        }
        // An absent activity is "no expression engine", never a default.
        XCTAssertNil(AvatarExpression.parseActivity(nil))
    }
}
