import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

@MainActor
final class AvatarExpressionEngineTests: XCTestCase {
    private var now: TimeInterval = 0

    private func makeEngine(randoms: [Double] = [0.5]) -> AvatarExpressionEngine {
        var index = 0
        return AvatarExpressionEngine(
            clock: { [unowned self] in self.now },
            random: {
                defer { index += 1 }
                return randoms[index % randoms.count]
            })
    }

    private func run(
        _ engine: AvatarExpressionEngine, seconds: TimeInterval, step: TimeInterval = 1.0 / 60.0
    ) {
        let end = now + seconds
        while now < end {
            now = min(end, now + step)
            engine.advance(to: now)
        }
    }

    func testFirstConfigureAdoptsItsShapeInstantly() {
        let engine = makeEngine()
        engine.configure(activity: .working, frozen: false, reduceMotion: false, blink: false)

        XCTAssertEqual(engine.snapshot.shape, 1)
    }

    func testActivityChangeCommitsTheShapeAtTheBlinkApex() {
        let engine = makeEngine()
        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.2)
        XCTAssertEqual(engine.snapshot.shape, 0)

        engine.configure(activity: .working, frozen: false, reduceMotion: false, blink: false)

        run(engine, seconds: 2.0 / 60.0)
        XCTAssertEqual(engine.snapshot.shape, 0, accuracy: 0.000_001)
        XCTAssertLessThan(engine.snapshot.blinkScale, 1)

        run(engine, seconds: AvatarExpression.blinkApexSeconds)
        XCTAssertEqual(engine.snapshot.shape, 1)

        run(engine, seconds: AvatarExpression.blinkOutSeconds + 0.05)
        XCTAssertEqual(engine.snapshot.blinkScale, 1, accuracy: 0.000_001)
    }

    func testWorkingReturnsToTheCircleWhenTheToolCallEnds() {
        let engine = makeEngine()
        engine.configure(activity: .working, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.2)

        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: AvatarExpression.blinkApexSeconds + 0.05)

        XCTAssertEqual(engine.snapshot.shape, 0)
    }

    func testGlowerCutsATopLidAndReleasesIt() {
        let engine = makeEngine()
        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.2)
        XCTAssertEqual(engine.snapshot.lidTop, 0, accuracy: 0.000_001)

        engine.glower()
        run(engine, seconds: 0.6)
        XCTAssertGreaterThan(engine.snapshot.lidTop, 0.2)

        run(engine, seconds: AvatarExpression.glowerSeconds + 1)
        XCTAssertLessThan(engine.snapshot.lidTop, 0.01)
    }

    func testScrutinyHoldsForOneSecondFromTheLastKeystroke() {
        let engine = makeEngine()
        engine.configure(activity: .awaiting, frozen: false, reduceMotion: false, blink: false)

        engine.scrutinize()
        run(engine, seconds: 0.4)
        XCTAssertGreaterThan(engine.snapshot.lidBottom, 0.1)

        engine.scrutinize()
        run(engine, seconds: 0.7)
        XCTAssertGreaterThan(engine.snapshot.lidBottom, 0.1)

        run(engine, seconds: AvatarExpression.scrutinySeconds + 1)
        XCTAssertLessThan(engine.snapshot.lidBottom, 0.01)
    }

    func testAwaitingDrowsesPastItsDelayAndWakesBackUp() {
        let engine = makeEngine()
        engine.configure(
            activity: .awaiting, frozen: false, reduceMotion: false, blink: false,
            drowseDelay: 1)
        run(engine, seconds: 0.5)

        XCTAssertEqual(engine.snapshot.lidTop, AvatarExpression.drowseStartLid, accuracy: 0.01)

        run(engine, seconds: 4)
        let drowsing = engine.snapshot.lidTop
        XCTAssertGreaterThan(drowsing, AvatarExpression.drowseStartLid)

        engine.wake()
        run(engine, seconds: 1.0 / 60.0)

        XCTAssertGreaterThan(engine.snapshot.pupilScale, 1)

        run(engine, seconds: 0.6)
        XCTAssertLessThan(engine.snapshot.lidTop, drowsing)
        XCTAssertEqual(engine.snapshot.pupilScale, 1, accuracy: 0.000_001)
    }

    func testBrowsShowOnlyWhileThinkingAndRecockOnTheBlink() {
        let engine = makeEngine(randoms: [0.1, 0.5, 0.5, 0.5, 0.5])
        engine.configure(activity: .idle, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.2)
        XCTAssertFalse(engine.snapshot.browsVisible)

        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.2)
        XCTAssertTrue(engine.snapshot.browsVisible)
        let opening = engine.snapshot.brows

        XCTAssertNotEqual(
            opening.left.raise < 0, opening.right.raise < 0,
            "exactly one brow should be raised")

        engine.wake()
        run(engine, seconds: AvatarExpression.blinkApexSeconds + 0.05)
        XCTAssertNotEqual(engine.snapshot.brows, opening)
    }

    func testThinkingAndIdleMoveTheirOwnGazeWhileWorkingDoesNot() {
        let engine = makeEngine(randoms: [0.4, 0.9, 0.2])
        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.05)
        let first = engine.snapshot.leftPupilOffset
        run(engine, seconds: 0.3)
        XCTAssertNotEqual(engine.snapshot.leftPupilOffset, first)

        engine.configure(activity: .working, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: AvatarExpression.blinkApexSeconds + 0.1)
        let parked = engine.snapshot.leftPupilOffset
        run(engine, seconds: 0.5)
        XCTAssertEqual(engine.snapshot.leftPupilOffset, parked)
    }

    func testAwaitingHoldsEyeContactWithTheUser() {
        let engine = makeEngine()
        engine.configure(activity: .idle, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 2)

        let wandering = engine.snapshot.leftPupilOffset
        XCTAssertGreaterThan(
            (wandering.x * wandering.x + wandering.y * wandering.y).squareRoot(), 1)

        engine.configure(activity: .awaiting, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 2)
        XCTAssertEqual(engine.snapshot.leftPupilOffset.x, 0, accuracy: 0.01)
        XCTAssertEqual(engine.snapshot.leftPupilOffset.y, 0, accuracy: 0.01)
        XCTAssertEqual(engine.snapshot.rightPupilOffset.x, 0, accuracy: 0.01)
    }

    func testGazeNeverLeavesTheCircularTravelClamp() {
        let engine = makeEngine(randoms: [0.3, 0.7, 0.1, 0.9])
        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)

        for _ in 0..<40 {
            run(engine, seconds: 0.25)
            let offset = engine.snapshot.leftPupilOffset
            XCTAssertLessThanOrEqual(
                (offset.x * offset.x + offset.y * offset.y).squareRoot(),
                AvatarExpression.maxOffset + 0.000_001)
        }
    }

    func testStaticFreezesEveryChannel() {
        let engine = makeEngine()
        engine.configure(activity: .working, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.5)
        let frozenShape = engine.snapshot.shape
        XCTAssertEqual(frozenShape, 1)

        engine.configure(activity: .thinking, frozen: true, reduceMotion: false, blink: true)
        engine.glower()
        run(engine, seconds: 2)

        XCTAssertEqual(engine.snapshot.shape, frozenShape)
        XCTAssertEqual(engine.snapshot.lidTop, 0)
        XCTAssertEqual(engine.snapshot.blinkScale, 1)
    }

    func testReducedMotionSettlesInstantlyWithoutBlinksOrPops() {
        let engine = makeEngine()
        engine.configure(activity: .thinking, frozen: false, reduceMotion: true, blink: true)
        engine.configure(activity: .working, frozen: false, reduceMotion: true, blink: true)

        XCTAssertEqual(engine.snapshot.shape, 1)
        XCTAssertEqual(engine.snapshot.blinkScale, 1)

        engine.glower()
        XCTAssertEqual(engine.snapshot.lidTop, AvatarExpression.glowerLid)

        engine.wake()
        XCTAssertEqual(engine.snapshot.pupilScale, 1)
        XCTAssertEqual(engine.snapshot.leftPupilOffset, .init(x: 0, y: 0))

        engine.configure(activity: .thinking, frozen: false, reduceMotion: true, blink: true)
        XCTAssertEqual(engine.snapshot.brows, AvatarExpression.baseBrows)
    }

    func testReducedMotionDrowseJumpsToItsSettledCut() {
        let engine = makeEngine()
        engine.configure(
            activity: .awaiting, frozen: false, reduceMotion: true, blink: false, drowseDelay: 1)
        XCTAssertEqual(engine.snapshot.lidTop, AvatarExpression.drowseStartLid, accuracy: 0.000_001)

        now += 10
        engine.advance(to: now)

        XCTAssertEqual(engine.snapshot.lidTop, AvatarExpression.drowseEndLid, accuracy: 0.000_001)
    }

    func testResetExpressionDropsTransientsAndRePrimesTheShape() {
        let engine = makeEngine()
        engine.configure(activity: .working, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.4)
        engine.glower()
        engine.scrutinize()
        run(engine, seconds: 0.4)
        XCTAssertGreaterThan(engine.snapshot.lidTop, 0.2)
        XCTAssertGreaterThan(engine.snapshot.lidBottom, 0.1)

        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)
        engine.resetExpression()

        XCTAssertEqual(engine.snapshot.lidTop, 0)
        XCTAssertEqual(engine.snapshot.lidBottom, 0)
        XCTAssertEqual(engine.snapshot.brows, AvatarExpression.baseBrows)

        XCTAssertEqual(engine.snapshot.shape, 0)

        run(engine, seconds: 0.5)
        XCTAssertLessThan(engine.snapshot.lidTop, 0.01)
        XCTAssertLessThan(engine.snapshot.lidBottom, 0.01)
    }

    private func summary(_ state: String?, activity: String? = nil) -> ScoopSummary {
        .init(
            jid: "s", name: "reviewer", folder: "/scoops/reviewer", isCone: false,
            assistantLabel: "Reviewer", trigger: nil, state: state, activity: activity,
            fill: 40)
    }

    func testWireAloneDrivesUnwatchedScoops() {

        XCTAssertEqual(summary("working", activity: "thinking").avatarActivity(), .thinking)
        XCTAssertEqual(summary("working", activity: "tool").avatarActivity(), .working)
        XCTAssertEqual(summary("idle", activity: "awaiting").avatarActivity(), .awaiting)
        XCTAssertEqual(summary("idle").avatarActivity(), .idle)
        XCTAssertEqual(summary(nil).avatarActivity(), .idle)

        XCTAssertNil(summary("broken").avatarActivity())
        XCTAssertNil(summary("initializing").avatarActivity())
    }

    func testOlderLeaderAndUnknownRefinementFallBackToTheState() {

        XCTAssertEqual(summary("working").avatarActivity(), .thinking)

        XCTAssertEqual(summary("working", activity: "daydreaming").avatarActivity(), .thinking)
        XCTAssertEqual(summary("idle", activity: "daydreaming").avatarActivity(), .idle)
        XCTAssertEqual(summary("future-state").avatarActivity(), .idle)
    }

    func testLocalSignalsOutrankTheWireForTheFocusedScoop() {
        let toolRunning = ScoopSummary.LocalExpressionSignals(toolRunning: true)
        let quiet = ScoopSummary.LocalExpressionSignals()

        XCTAssertEqual(
            summary("working", activity: "thinking").avatarActivity(local: toolRunning), .working)

        XCTAssertEqual(
            summary("working", activity: "tool").avatarActivity(local: quiet), .thinking)

        XCTAssertEqual(summary("idle").avatarActivity(local: .init(awaitingUser: true)), .awaiting)
        XCTAssertEqual(summary("idle").avatarActivity(local: quiet), .idle)

        XCTAssertEqual(summary("idle", activity: "awaiting").avatarActivity(local: quiet), .awaiting)
    }

    func testRefinementNeverChangesTheLegacyEyeTreatments() {

        for activity in [nil, "thinking", "tool", "awaiting", "daydreaming"] {
            let busy = summary("working", activity: activity).avatarGeometry()
            XCTAssertTrue(busy.blink)
            XCTAssertEqual(busy.eyes, .open)

            let resting = summary("idle", activity: activity).avatarGeometry()
            XCTAssertFalse(resting.blink)
            XCTAssertEqual(resting.eyes, .open)
        }
        XCTAssertEqual(summary("broken").avatarGeometry().eyes, .dead)
        XCTAssertEqual(summary("initializing").avatarGeometry().eyes, .none)
    }

    func testGeometryCarriesTheActivityAndScalesTheGrammarIntoPoints() {
        let geometry = SliccAgentAvatarGeometry(
            type: .scoop, color: "#8B5CF6", fill: 50, sideLength: 100, activity: .working)

        XCTAssertEqual(geometry.activity, .working)

        XCTAssertEqual(
            geometry.expressionScale, geometry.eyeRadius / AvatarExpression.eyeRadius,
            accuracy: 0.000_001)
        XCTAssertEqual(
            geometry.socketCornerRadius(shape: 0), geometry.eyeRadius, accuracy: 0.000_001)
        XCTAssertEqual(
            geometry.socketCornerRadius(shape: 1),
            AvatarExpression.socketMinRx * geometry.expressionScale, accuracy: 0.000_001)
        XCTAssertEqual(
            geometry.pupilCornerRadius(shape: 1, radius: 10),
            10 * AvatarExpression.pupilMinFraction, accuracy: 0.000_001)
        XCTAssertEqual(geometry.lidInset(fraction: 0.5), geometry.eyeDiameter / 2)

        XCTAssertEqual(
            geometry.chordHalfWidth(fraction: 0.5, shape: 0, edge: .top),
            geometry.eyeRadius, accuracy: 0.000_001)
    }

    func testAbsentActivityKeepsTheLegacyFace() {
        let geometry = SliccAgentAvatarGeometry(
            type: .cone, color: "#D2691E", fill: 20, sideLength: 26)
        XCTAssertNil(geometry.activity)
    }
}
