import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

/// The expression engine's behaviour, stepped at exact times.
///
/// Time is a parameter here, never an ambient read: the integrator advances per
/// FRAME with a clamped `dt`, so anything asserted against a real clock would
/// be a race. `advance(to:)` makes the blink-gate apex, the 1s scrutiny window
/// and the 90s drowse ramp exactly reproducible — the same lesson the web side
/// learned from a flaky CI run.
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

    /// Step the engine forward in frame-sized slices, like a timeline would.
    private func run(
        _ engine: AvatarExpressionEngine, seconds: TimeInterval, step: TimeInterval = 1.0 / 60.0
    ) {
        let end = now + seconds
        while now < end {
            now = min(end, now + step)
            engine.advance(to: now)
        }
    }

    // MARK: - Shape channel

    func testFirstConfigureAdoptsItsShapeInstantly() {
        let engine = makeEngine()
        engine.configure(activity: .working, frozen: false, reduceMotion: false, blink: false)

        // No morph ever slides in front of the user on first paint.
        XCTAssertEqual(engine.snapshot.shape, 1)
    }

    func testActivityChangeCommitsTheShapeAtTheBlinkApex() {
        let engine = makeEngine()
        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.2)
        XCTAssertEqual(engine.snapshot.shape, 0)

        engine.configure(activity: .working, frozen: false, reduceMotion: false, blink: false)
        // Two frames in: the lid is falling and the shape has NOT moved. (One
        // frame in, the blink has started but not yet travelled — scale is
        // exactly 1 at elapsed 0.)
        run(engine, seconds: 2.0 / 60.0)
        XCTAssertEqual(engine.snapshot.shape, 0, accuracy: 0.000_001)
        XCTAssertLessThan(engine.snapshot.blinkScale, 1)

        // Past the apex: the swap has landed behind a closed lid.
        run(engine, seconds: AvatarExpression.blinkApexSeconds)
        XCTAssertEqual(engine.snapshot.shape, 1)

        // And the lid comes back up.
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

    // MARK: - Lids

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

        // Each keystroke re-arms the full second.
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
        // The soft arrival lid, before the ramp starts.
        XCTAssertEqual(engine.snapshot.lidTop, AvatarExpression.drowseStartLid, accuracy: 0.01)

        run(engine, seconds: 4)
        let drowsing = engine.snapshot.lidTop
        XCTAssertGreaterThan(drowsing, AvatarExpression.drowseStartLid)

        engine.wake()
        run(engine, seconds: 1.0 / 60.0)
        // The pop is a transient on the pupil, so context fill stays honest.
        XCTAssertGreaterThan(engine.snapshot.pupilScale, 1)

        run(engine, seconds: 0.6)
        XCTAssertLessThan(engine.snapshot.lidTop, drowsing)
        XCTAssertEqual(engine.snapshot.pupilScale, 1, accuracy: 0.000_001)
    }

    // MARK: - Brows

    func testBrowsShowOnlyWhileThinkingAndRecockOnTheBlink() {
        let engine = makeEngine(randoms: [0.1, 0.5, 0.5, 0.5, 0.5])
        engine.configure(activity: .idle, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.2)
        XCTAssertFalse(engine.snapshot.browsVisible)

        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.2)
        XCTAssertTrue(engine.snapshot.browsVisible)
        let opening = engine.snapshot.brows
        // One cocked, one settled — never a symmetric pair.
        XCTAssertNotEqual(
            opening.left.raise < 0, opening.right.raise < 0,
            "exactly one brow should be raised")

        engine.wake()  // any blink re-cocks
        run(engine, seconds: AvatarExpression.blinkApexSeconds + 0.05)
        XCTAssertNotEqual(engine.snapshot.brows, opening)
    }

    // MARK: - Gaze

    func testThinkingAndIdleMoveTheirOwnGazeWhileWorkingDoesNot() {
        let engine = makeEngine(randoms: [0.4, 0.9, 0.2])
        engine.configure(activity: .thinking, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.05)
        let first = engine.snapshot.leftPupilOffset
        run(engine, seconds: 0.3)
        XCTAssertNotEqual(engine.snapshot.leftPupilOffset, first)

        // A tool call hands the gaze to CoreMotion tilt: the engine lets go.
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
        // Magnitude, not one axis: a wander target can sit directly above an eye.
        let wandering = engine.snapshot.leftPupilOffset
        XCTAssertGreaterThan(
            (wandering.x * wandering.x + wandering.y * wandering.y).squareRoot(), 1)

        // On iOS there is no pointer and no composer to aim at: the agent looks
        // straight out at you.
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

    // MARK: - Precedence

    func testStaticFreezesEveryChannel() {
        let engine = makeEngine()
        engine.configure(activity: .working, frozen: false, reduceMotion: false, blink: false)
        run(engine, seconds: 0.5)
        let frozenShape = engine.snapshot.shape
        XCTAssertEqual(frozenShape, 1)

        // Connection trouble outranks everything: motion here would read as
        // liveness the agent does not have.
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

        // Instant, no blink-gate.
        XCTAssertEqual(engine.snapshot.shape, 1)
        XCTAssertEqual(engine.snapshot.blinkScale, 1)

        engine.glower()
        XCTAssertEqual(engine.snapshot.lidTop, AvatarExpression.glowerLid)

        engine.wake()
        XCTAssertEqual(engine.snapshot.pupilScale, 1)
        XCTAssertEqual(engine.snapshot.leftPupilOffset, .init(x: 0, y: 0))

        // Brows stay parked at the base pose rather than re-cocking.
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
        // The 12s descent IS the motion, so it is skipped, not animated.
        XCTAssertEqual(engine.snapshot.lidTop, AvatarExpression.drowseEndLid, accuracy: 0.000_001)
    }

    // MARK: - Reuse

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
        // A different creature, not a state change of the same one: instant.
        XCTAssertEqual(engine.snapshot.shape, 0)

        run(engine, seconds: 0.5)
        XCTAssertLessThan(engine.snapshot.lidTop, 0.01)
        XCTAssertLessThan(engine.snapshot.lidBottom, 0.01)
    }

    // MARK: - Lifecycle mapping

    private func summary(_ state: String?) -> ScoopSummary {
        .init(
            jid: "s", name: "reviewer", folder: "/scoops/reviewer", isCone: false,
            assistantLabel: "Reviewer", trigger: nil, state: state, fill: 40)
    }

    func testWireStateAloneDrivesUnwatchedScoops() {
        // No local signals: the tabs and tiles this follower is not streaming
        // read the wire and nothing else.
        XCTAssertEqual(summary("thinking").avatarActivity(), .thinking)
        XCTAssertEqual(summary("working").avatarActivity(), .working)
        XCTAssertEqual(summary("awaiting").avatarActivity(), .awaiting)
        XCTAssertEqual(summary("idle").avatarActivity(), .idle)
        XCTAssertEqual(summary(nil).avatarActivity(), .idle)
        XCTAssertEqual(summary("future-state").avatarActivity(), .idle)
        // Broken and initializing keep their own eye treatments instead.
        XCTAssertNil(summary("broken").avatarActivity())
        XCTAssertNil(summary("initializing").avatarActivity())
    }

    func testLocalSignalsOutrankTheWireForTheFocusedScoop() {
        let toolRunning = ScoopSummary.LocalExpressionSignals(toolRunning: true)
        let quiet = ScoopSummary.LocalExpressionSignals()

        // A locally observed tool bracket wins over a wire that still says
        // thinking — the follower sees it a broadcast earlier.
        XCTAssertEqual(summary("thinking").avatarActivity(local: toolRunning), .working)
        // And its absence wins the other way, which is what keeps a leader that
        // predates the finer states rendering correctly: it says `working`, no
        // local tool is running, so the face thinks.
        XCTAssertEqual(summary("working").avatarActivity(local: quiet), .thinking)

        // The turn settle is local too.
        XCTAssertEqual(
            summary("idle").avatarActivity(
                local: .init(awaitingUser: true)), .awaiting)
        XCTAssertEqual(summary("idle").avatarActivity(local: quiet), .idle)
        // …but the leader's own `awaiting` still stands when local has nothing.
        XCTAssertEqual(summary("awaiting").avatarActivity(local: quiet), .awaiting)
    }

    func testBusyStatesKeepBlinkingAndOpenEyes() {
        for state in ["working", "thinking"] {
            let geometry = summary(state).avatarGeometry()
            XCTAssertTrue(geometry.blink, "\(state) is mid-turn and should blink")
            XCTAssertEqual(geometry.eyes, .open)
        }
        for state in ["awaiting", "idle"] {
            let geometry = summary(state).avatarGeometry()
            XCTAssertFalse(geometry.blink, "\(state) is not mid-turn")
            XCTAssertEqual(geometry.eyes, .open)
        }
        XCTAssertEqual(summary("broken").avatarGeometry().eyes, .dead)
        XCTAssertEqual(summary("initializing").avatarGeometry().eyes, .none)
    }

    func testGeometryCarriesTheActivityAndScalesTheGrammarIntoPoints() {
        let geometry = SliccAgentAvatarGeometry(
            type: .scoop, color: "#8B5CF6", fill: 50, sideLength: 100, activity: .working)

        XCTAssertEqual(geometry.activity, .working)
        // Band units scale into points by exactly one factor.
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
        // A lid at rest hides its chord line; an engaged one spans the socket.
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
