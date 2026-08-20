import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

@MainActor
private final class ManuallyEmittingAvatarTiltSource: SliccAgentAvatarTiltSource {
    var isDeviceMotionAvailable = true
    private var handler: (@MainActor (SliccAgentAvatarAttitude) -> Void)?

    func startDeviceMotionUpdates(
        _ handler: @escaping @MainActor (SliccAgentAvatarAttitude) -> Void
    ) {
        self.handler = handler
    }

    func stopDeviceMotionUpdates() {
        handler = nil
    }

    func emit(_ attitude: SliccAgentAvatarAttitude) {
        handler?(attitude)
    }
}

@MainActor
final class SliccAgentAvatarGeometryTests: XCTestCase {
    private let accuracy = 0.000_001

    /// The scoop band: `TYPE.scoop` is `left 15% / top 30% / 70x45%` at
    /// `zoom 2.65`, so one 200x100 band unit is `2.65 * 0.0035 = 0.9275%` of
    /// the tile side. Every socket length below is that unit times the band
    /// constant `slicc-agent-avatar.ts` uses.
    func testScoopGeometryMatchesWebEyeBandPlacement() {
        let geometry = SliccAgentAvatarGeometry(
            type: .scoop, color: "#8B5CF6", fill: 50, sideLength: 100)
        let unit = 0.9275

        XCTAssertEqual(geometry.tileCornerRadius, 26.9, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeRadius, 38 * unit, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeOutlineWidth, 4 * unit, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeCenters[0].x, 8.2625, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeCenters[1].x, 91.7375, accuracy: accuracy)
        XCTAssertEqual(geometry.pupilRadius, 18 * unit, accuracy: accuracy)
        XCTAssertEqual(geometry.highlightRadius, 0.4 * 18 * unit, accuracy: accuracy)
        XCTAssertEqual(geometry.highlightOffset.x, -0.3 * 18 * unit, accuracy: accuracy)
        XCTAssertEqual(geometry.highlightOffset.y, -0.35 * 18 * unit, accuracy: accuracy)
        XCTAssertEqual(geometry.maxPupilTravel, 16 * unit, accuracy: accuracy)
    }

    /// The cone crops the SAME band harder: `left 17% / top -18.5% / 70x44%` at
    /// `zoom 3`, so its unit is `3 * 0.0035 = 1.05%` — bigger sockets pushed
    /// almost onto the tile edges. Reusing the scoop's placement (the bug this
    /// pins) shrank cone eyes and pulled them inboard.
    func testConeGeometryUsesItsOwnEyeBandPlacement() {
        let geometry = SliccAgentAvatarGeometry(
            type: .cone, color: "#B07823", fill: 50, sideLength: 100)
        let unit = 1.05

        XCTAssertEqual(geometry.eyeRadius, 38 * unit, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeOutlineWidth, 4 * unit, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeCenters[0].x, 2.75, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeCenters[1].x, 97.25, accuracy: accuracy)
        XCTAssertEqual(geometry.pupilRadius, 18 * unit, accuracy: accuracy)
        XCTAssertEqual(geometry.maxPupilTravel, 16 * unit, accuracy: accuracy)
    }

    /// Whatever the type, both sockets sit on ONE horizontal line and stay
    /// mirrored about the tile centre — the band's `EYE_CY` is shared and its
    /// two `cx` values are symmetric. This is the invariant the header avatar
    /// broke when the animating path stacked the eyes vertically.
    func testEyesShareOneBaselineAndMirrorAboutTheTileCentre() {
        for type in [SliccAgentAvatarGeometry.AvatarType.scoop, .cone] {
            let geometry = SliccAgentAvatarGeometry(
                type: type, color: "#8B5CF6", fill: 50, sideLength: 100)
            let left = geometry.eyeCenters[0]
            let right = geometry.eyeCenters[1]

            XCTAssertEqual(left.y, right.y, accuracy: accuracy, "\(type) eyes off one baseline")
            XCTAssertEqual(left.y, 50, accuracy: accuracy, "\(type) baseline off tile centre")
            XCTAssertEqual(left.x, 100 - right.x, accuracy: accuracy, "\(type) eyes not mirrored")
        }
    }

    func testFillScaleMatchesWebBoundariesAndMidpoint() {
        XCTAssertEqual(SliccAgentAvatarGeometry.fillScale(for: 50), 1, accuracy: accuracy)
        XCTAssertEqual(SliccAgentAvatarGeometry.fillScale(for: 67.5), 1.6, accuracy: accuracy)
        XCTAssertEqual(SliccAgentAvatarGeometry.fillScale(for: 85), 2.2, accuracy: accuracy)
    }

    func testStaticNoiseParametersMatchWebRenderer() {
        XCTAssertEqual(SliccAgentAvatarGeometry.noiseCellSize, 1)
        XCTAssertEqual(SliccAgentAvatarGeometry.noiseFramesPerSecond, 12)
        XCTAssertEqual(SliccAgentAvatarGeometry.noiseOpacity, 0.72)
        XCTAssertEqual(SliccAgentAvatarGeometry.noiseLuminance, [0.08, 0.36, 0.68, 0.94])
        XCTAssertEqual(SliccAgentAvatarGeometry.frozenNoiseSeed, 0x51CC_A11E)
        XCTAssertEqual(SliccAgentAvatarGeometry.noiseFrameSalt, 0x9E37_79B9)
        XCTAssertEqual(SliccAgentAvatarGeometry.noiseEyeSalt, 0x85EB_CA6B)

        let geometry = SliccAgentAvatarGeometry(
            type: .scoop, color: "#8B5CF6", eyes: .static, sideLength: 20)
        let cellsPerAxis = Int(ceil(geometry.eyeDiameter / SliccAgentAvatarGeometry.noiseCellSize))
        XCTAssertEqual(cellsPerAxis * cellsPerAxis, 225)
    }

    func testComputedZeroStaticNoiseSeedNormalizesToWebSequence() {
        let zeroSeedFrame: UInt32 = 968_638_734
        let computedSeed =
            SliccAgentAvatarGeometry.frozenNoiseSeed
            ^ (zeroSeedFrame &* SliccAgentAvatarGeometry.noiseFrameSalt)
        XCTAssertEqual(computedSeed, 0)
        var noise = AvatarNoiseGenerator(seed: computedSeed)

        XCTAssertEqual(
            (0..<12).map { _ in noise.next() },
            [
                2_014_281_417, 1_830_072_674, 2_619_937_598, 2_006_912_825,
                1_500_832_933, 2_045_046_005, 1_799_219_144, 794_102_122,
                1_098_499_222, 1_150_039_043, 2_206_897_573, 4_143_315_578,
            ])
    }

    func testAnimatedStaticNoiseSeedsMatchWebRendererAtOneSecond() {
        let frame = UInt32(SliccAgentAvatarGeometry.noiseFramesPerSecond)
        let leftSeed =
            SliccAgentAvatarGeometry.frozenNoiseSeed
            ^ (frame &* SliccAgentAvatarGeometry.noiseFrameSalt)
        let rightSeed =
            (SliccAgentAvatarGeometry.frozenNoiseSeed
                ^ SliccAgentAvatarGeometry.noiseEyeSalt) ^ (frame &* SliccAgentAvatarGeometry.noiseFrameSalt)

        XCTAssertEqual(leftSeed, 995_431_858)
        XCTAssertEqual(rightSeed, 3_200_180_185)
    }

    func testMaxTravelClampsAtBothBounds() {
        // Band units per tile side: 1.05% on the cone, 0.9275% on the scoop.
        let lowFill = SliccAgentAvatarGeometry(
            type: .cone, color: "#F59E0B", fill: 0, sideLength: 100)
        let highFill = SliccAgentAvatarGeometry(
            type: .scoop, color: "#F97316", fill: 100, sideLength: 100)
        let midpoint = SliccAgentAvatarGeometry(
            type: .scoop, color: "#8B5CF6", fill: 67.5, sideLength: 100)

        // Upper bound: the web's `min(MAX_OFFSET, …)` at 16 band units.
        XCTAssertEqual(lowFill.maxPupilTravel, 16 * 1.05, accuracy: accuracy)
        // Lower bound: the web's `max(2, …)` floor, once a full pupil eats the socket.
        XCTAssertEqual(highFill.maxPupilTravel, 2 * 0.9275, accuracy: accuracy)
        // In between, the unclamped `r - pupil - stroke` wins.
        XCTAssertEqual(
            midpoint.maxPupilTravel,
            (38 - 18 * 1.6 - 4) * 0.9275, accuracy: accuracy)
    }

    func testPupilOffsetUsesRadialMaxTravelClamp() {
        let geometry = SliccAgentAvatarGeometry(
            type: .scoop, color: "#8B5CF6", fill: 67.5, sideLength: 100)

        XCTAssertEqual(geometry.clampedPupilOffset(.init(x: 1, y: 2)), .init(x: 1, y: 2))
        let clamped = geometry.clampedPupilOffset(.init(x: 30, y: 40))
        // (30, 40) has length 50, so the clamp scales it to maxPupilTravel/50.
        XCTAssertEqual(clamped.x, 30 * geometry.maxPupilTravel / 50, accuracy: accuracy)
        XCTAssertEqual(clamped.y, 40 * geometry.maxPupilTravel / 50, accuracy: accuracy)
        XCTAssertEqual(hypot(clamped.x, clamped.y), geometry.maxPupilTravel, accuracy: accuracy)
    }

    func testInputsClampToSupportedRanges() {
        let geometry = SliccAgentAvatarGeometry(
            type: .cone, color: "#D2691E", fill: 120, sideLength: -26)
        XCTAssertEqual(geometry.fill, 100)
        XCTAssertEqual(geometry.sideLength, 0)
    }

    func testScoopSummaryMapsTypeFillAndBrowserPaletteColors() {
        let cone = scoopSummary(isCone: true, fill: 42).avatarGeometry(sideLength: 22)
        let reviewer = scoopSummary(isCone: false, name: "reviewer", fill: 82).avatarGeometry(
            sideLength: 24)
        let coder = scoopSummary(isCone: false, name: "coder", fill: 64).avatarGeometry()
        let rocket = scoopSummary(isCone: false, name: "🚀", fill: 12).avatarGeometry()
        let pileOfPoo = scoopSummary(isCone: false, name: "💩", fill: 12).avatarGeometry()

        XCTAssertEqual(cone.type, .cone)
        XCTAssertEqual(cone.color, "#b07823")
        XCTAssertEqual(cone.eyes, .open)
        XCTAssertEqual(cone.fill, 42)
        XCTAssertEqual(cone.sideLength, 22)
        XCTAssertEqual(reviewer.type, .scoop)
        XCTAssertEqual(reviewer.color, "#ef4444")
        XCTAssertEqual(reviewer.fill, 82)
        XCTAssertEqual(reviewer.sideLength, 24)
        XCTAssertEqual(coder.color, "#10b981")
        XCTAssertEqual(rocket.color, "#8b5cf6")
        XCTAssertEqual(pileOfPoo.color, "#8b5cf6")
        XCTAssertNotEqual(reviewer.color, coder.color)
    }

    func testScoopSummaryMapsEveryLifecycleState() {
        let cases: [(String?, SliccAgentAvatarGeometry.EyeState, Bool)] = [
            (nil, .open, false),
            ("idle", .open, false),
            ("working", .open, true),
            ("broken", .dead, false),
            ("initializing", .none, false),
        ]

        for (state, eyes, blink) in cases {
            let geometry = scoopSummary(isCone: false, state: state, fill: 50).avatarGeometry()
            XCTAssertEqual(geometry.eyes, eyes, "Unexpected eyes for state \(state ?? "absent")")
            XCTAssertEqual(geometry.blink, blink, "Unexpected blink for state \(state ?? "absent")")
        }
    }

    func testScoopSummaryAbsentFillStaysAbsent() {
        let geometry = scoopSummary(isCone: false, state: nil, fill: nil).avatarGeometry()

        XCTAssertNil(geometry.fill)
        XCTAssertEqual(geometry.pupilRadius, 18 * 0.009275 * 26, accuracy: accuracy)
    }

    func testScoopSummaryMapsLifecycleToWebEyeStates() {
        XCTAssertEqual(
            scoopSummary(isCone: false, state: "broken", fill: 20).avatarGeometry().eyes,
            .dead)
        XCTAssertEqual(
            scoopSummary(isCone: false, state: "initializing", fill: 20).avatarGeometry().eyes,
            .none)
        for state in ["working", "idle", nil] as [String?] {
            XCTAssertEqual(
                scoopSummary(isCone: false, state: state, fill: 20).avatarGeometry().eyes,
                .open)
        }
    }

    func testZeroTiltCentersPupils() {
        let offset = tiltMapping.pupilOffset(
            for: .zero, geometry: tiltGeometry, reduceMotion: false,
            isDeviceMotionAvailable: true)

        XCTAssertEqual(offset, .init(x: 0, y: 0))
    }

    func testExtremeTiltSaturatesAtMaxTravel() {
        let offset = tiltMapping.pupilOffset(
            for: .init(roll: 10, pitch: -10), geometry: tiltGeometry,
            reduceMotion: false, isDeviceMotionAvailable: true)

        XCTAssertEqual(
            hypot(offset.x, offset.y), tiltGeometry.maxPupilTravel, accuracy: accuracy)
    }

    func testPortraitTiltOutputPreservesScreenCoordinateMapping() {
        let offset = tiltMapping.pupilOffset(
            for: .init(roll: 0.1, pitch: 0.2), geometry: tiltGeometry,
            reduceMotion: false, isDeviceMotionAvailable: true)
        let scale = tiltGeometry.maxPupilTravel / SliccAgentAvatarTiltMapping.defaultFullTravelTilt

        XCTAssertEqual(offset.x, 0.1 * scale, accuracy: accuracy)
        XCTAssertEqual(offset.y, -0.2 * scale, accuracy: accuracy)
    }

    func testLandscapeOrientationsSwapAxesWithOppositeSigns() {
        let attitude = SliccAgentAvatarAttitude(roll: 0.1, pitch: 0.2)
        let portrait = tiltMapping.pupilOffset(
            for: attitude, geometry: tiltGeometry, reduceMotion: false,
            isDeviceMotionAvailable: true, orientation: .portrait)
        let landscapeLeft = tiltMapping.pupilOffset(
            for: attitude, geometry: tiltGeometry, reduceMotion: false,
            isDeviceMotionAvailable: true, orientation: .landscapeLeft)
        let landscapeRight = tiltMapping.pupilOffset(
            for: attitude, geometry: tiltGeometry, reduceMotion: false,
            isDeviceMotionAvailable: true, orientation: .landscapeRight)

        XCTAssertEqual(landscapeLeft.x, portrait.y, accuracy: accuracy)
        XCTAssertEqual(landscapeLeft.y, -portrait.x, accuracy: accuracy)
        XCTAssertEqual(landscapeRight.x, -portrait.y, accuracy: accuracy)
        XCTAssertEqual(landscapeRight.y, portrait.x, accuracy: accuracy)
    }

    func testReducedMotionAndUnavailableMotionCenterPupils() {
        let attitude = SliccAgentAvatarAttitude(roll: 0.4, pitch: -0.3)

        XCTAssertEqual(
            tiltMapping.pupilOffset(
                for: attitude, geometry: tiltGeometry, reduceMotion: true,
                isDeviceMotionAvailable: true),
            .init(x: 0, y: 0))
        XCTAssertEqual(
            tiltMapping.pupilOffset(
                for: attitude, geometry: tiltGeometry, reduceMotion: false,
                isDeviceMotionAvailable: false),
            .init(x: 0, y: 0))
    }

    func testTiltControllerStartsOnceAndUsesFirstSampleAsNeutralTilt() {
        let source = FixedSliccAgentAvatarTiltSource(roll: 0.2, pitch: 0.1)
        let controller = SliccAgentAvatarTiltController(source: source)

        controller.update(geometry: tiltGeometry, motionDisabled: false)

        XCTAssertEqual(source.startCallCount, 1)
        XCTAssertEqual(controller.pupilOffset, .init(x: 0, y: 0))
    }

    func testTiltControllerKeepsConstantTiltCentered() {
        let source = ManuallyEmittingAvatarTiltSource()
        var time: TimeInterval = 0
        let controller = SliccAgentAvatarTiltController(source: source, clock: { time })
        controller.update(geometry: tiltGeometry, motionDisabled: false)

        source.emit(.init(roll: 0.2, pitch: 0.1))
        time = 1
        source.emit(.init(roll: 0.2, pitch: 0.1))

        XCTAssertEqual(controller.pupilOffset, .init(x: 0, y: 0))
    }

    func testTiltControllerMovesRelativeToAverageTilt() {
        let source = ManuallyEmittingAvatarTiltSource()
        var time: TimeInterval = 0
        let controller = SliccAgentAvatarTiltController(source: source, clock: { time })
        controller.update(geometry: tiltGeometry, motionDisabled: false)
        source.emit(.zero)

        time = 1
        source.emit(.init(roll: 0.04, pitch: 0.02))

        let expected = tiltMapping.pupilOffset(
            for: .init(roll: 0.02, pitch: 0.01), geometry: tiltGeometry,
            reduceMotion: false, isDeviceMotionAvailable: true)
        assertPoint(controller.pupilOffset, equals: expected)
    }

    func testTiltControllerAverageOnlyIncludesLastMinute() {
        let source = ManuallyEmittingAvatarTiltSource()
        var time: TimeInterval = 0
        let controller = SliccAgentAvatarTiltController(source: source, clock: { time })
        controller.update(geometry: tiltGeometry, motionDisabled: false)
        source.emit(.zero)
        time = 59
        source.emit(.init(roll: 0.2, pitch: 0.1))

        time = 61
        source.emit(.init(roll: 0.2, pitch: 0.1))

        assertPoint(controller.pupilOffset, equals: .init(x: 0, y: 0))
    }

    func testTiltControllerLimitsSpeedToOneEyeDiameterPerSecond() {
        let source = ManuallyEmittingAvatarTiltSource()
        var time: TimeInterval = 0
        let controller = SliccAgentAvatarTiltController(source: source, clock: { time })
        controller.update(geometry: tiltGeometry, motionDisabled: false)
        source.emit(.zero)

        time = 0.01
        source.emit(.init(roll: 10, pitch: -10))

        XCTAssertEqual(
            hypot(controller.pupilOffset.x, controller.pupilOffset.y),
            tiltGeometry.eyeDiameter * 0.01, accuracy: accuracy)
    }

    func testTiltControllerLimitsMovementAfterLongUpdateGap() {
        let source = ManuallyEmittingAvatarTiltSource()
        var time: TimeInterval = 0
        let controller = SliccAgentAvatarTiltController(source: source, clock: { time })
        controller.update(geometry: tiltGeometry, motionDisabled: false)
        source.emit(.zero)

        time = 60
        source.emit(.init(roll: 10, pitch: -10))

        XCTAssertEqual(
            hypot(controller.pupilOffset.x, controller.pupilOffset.y),
            tiltGeometry.eyeDiameter / 30, accuracy: accuracy)
    }

    func testTiltControllerDoesNotStartTwiceWhileUpdating() {
        let source = FixedSliccAgentAvatarTiltSource(roll: 0.2, pitch: 0.1)
        let controller = SliccAgentAvatarTiltController(source: source)

        controller.update(geometry: tiltGeometry, motionDisabled: false)
        controller.update(geometry: tiltGeometry, motionDisabled: false)

        XCTAssertEqual(source.startCallCount, 1)
    }

    func testTiltControllerReadsInjectedOrientationForEveryMotionSample() {
        let source = ManuallyEmittingAvatarTiltSource()
        var time: TimeInterval = 0
        var orientation = SliccAgentAvatarInterfaceOrientation.portrait
        var orientationReadCount = 0
        let controller = SliccAgentAvatarTiltController(
            source: source,
            clock: { time },
            interfaceOrientation: {
                orientationReadCount += 1
                return orientation
            })
        let attitude = SliccAgentAvatarAttitude(roll: 0.02, pitch: 0.04)
        controller.update(geometry: tiltGeometry, motionDisabled: false)

        source.emit(.zero)
        time = 1
        source.emit(attitude)
        let portraitTarget = tiltMapping.pupilOffset(
            for: .init(roll: 0.01, pitch: 0.02), geometry: tiltGeometry, reduceMotion: false,
            isDeviceMotionAvailable: true, orientation: .portrait)
        assertPoint(controller.pupilOffset, equals: portraitTarget)
        XCTAssertEqual(orientationReadCount, 2)

        orientation = .landscapeRight
        time = 2
        source.emit(attitude)
        let landscapeTarget = tiltMapping.pupilOffset(
            for: .init(roll: 0.02 / 3, pitch: 0.04 / 3), geometry: tiltGeometry,
            reduceMotion: false,
            isDeviceMotionAvailable: true, orientation: .landscapeRight)
        assertPoint(controller.pupilOffset, equals: landscapeTarget)
        XCTAssertEqual(orientationReadCount, 3)
    }

    func testTiltControllerMotionDisabledStopsAndCenters() {
        let source = FixedSliccAgentAvatarTiltSource(roll: 0.2, pitch: 0.1)
        let controller = SliccAgentAvatarTiltController(source: source)
        controller.update(geometry: tiltGeometry, motionDisabled: false)

        controller.update(geometry: tiltGeometry, motionDisabled: true)

        XCTAssertEqual(source.stopCallCount, 1)
        XCTAssertEqual(controller.pupilOffset, .init(x: 0, y: 0))
    }

    func testTiltControllerUnavailableMotionStopsAndCenters() {
        let source = FixedSliccAgentAvatarTiltSource(roll: 0.2, pitch: 0.1)
        let controller = SliccAgentAvatarTiltController(source: source)
        controller.update(geometry: tiltGeometry, motionDisabled: false)

        source.isDeviceMotionAvailable = false
        controller.update(geometry: tiltGeometry, motionDisabled: false)

        XCTAssertEqual(source.stopCallCount, 1)
        XCTAssertEqual(controller.pupilOffset, .init(x: 0, y: 0))
    }

    func testTiltControllerClosedEyesStopAndCenter() {
        for eyes in [SliccAgentAvatarGeometry.EyeState.dead, .none, .static] {
            let source = FixedSliccAgentAvatarTiltSource(roll: 0.2, pitch: 0.1)
            let controller = SliccAgentAvatarTiltController(source: source)
            controller.update(geometry: tiltGeometry, motionDisabled: false)
            let closedGeometry = SliccAgentAvatarGeometry(
                type: .scoop, color: "#8B5CF6", eyes: eyes, fill: 50, sideLength: 100)

            controller.update(geometry: closedGeometry, motionDisabled: false)

            XCTAssertEqual(source.stopCallCount, 1, "Expected \(eyes) eyes to stop motion")
            XCTAssertEqual(controller.pupilOffset, .init(x: 0, y: 0))
        }
    }

    func testTiltControllerStopAndCenterStopsSource() {
        let source = FixedSliccAgentAvatarTiltSource(roll: 0.2, pitch: 0.1)
        let controller = SliccAgentAvatarTiltController(source: source)
        controller.update(geometry: tiltGeometry, motionDisabled: false)

        controller.stopAndCenter()

        XCTAssertEqual(source.stopCallCount, 1)
        XCTAssertEqual(controller.pupilOffset, .init(x: 0, y: 0))
    }

    private var tiltGeometry: SliccAgentAvatarGeometry {
        .init(type: .scoop, color: "#8B5CF6", fill: 50, sideLength: 100)
    }

    private var tiltMapping: SliccAgentAvatarTiltMapping {
        .init()
    }

    private func assertPoint(
        _ point: SliccAgentAvatarGeometry.Point,
        equals expected: SliccAgentAvatarGeometry.Point
    ) {
        XCTAssertEqual(point.x, expected.x, accuracy: accuracy)
        XCTAssertEqual(point.y, expected.y, accuracy: accuracy)
    }

    private func scoopSummary(
        isCone: Bool, name: String? = nil, state: String? = nil, fill: Double?
    ) -> ScoopSummary {
        let scoopName = name ?? (isCone ? "sliccy" : "reviewer")
        return .init(
            jid: isCone ? "cone" : scoopName, name: scoopName,
            folder: isCone ? "/workspace" : "/scoops/\(scoopName)", isCone: isCone,
            assistantLabel: isCone ? "Sliccy" : "Reviewer", trigger: nil, state: state,
            fill: fill)
    }
}
