import XCTest

@testable import SliccFollower

@MainActor
final class SliccAgentAvatarGeometryTests: XCTestCase {
    private let accuracy = 0.000_001

    func testGeometryScalesFromTileSideLength() {
        let geometry = SliccAgentAvatarGeometry(
            type: .scoop, color: "#8B5CF6", fill: 50, sideLength: 100)

        XCTAssertEqual(geometry.tileCornerRadius, 26.9, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeRadius, 35.2, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeOutlineWidth, 3.7, accuracy: accuracy)
        XCTAssertEqual(geometry.eyeCenters[0], .init(x: 8.3, y: 50))
        XCTAssertEqual(geometry.eyeCenters[1], .init(x: 91.7, y: 50))
        XCTAssertEqual(geometry.pupilRadius, 16.7, accuracy: accuracy)
        XCTAssertEqual(geometry.highlightRadius, 6.68, accuracy: accuracy)
        XCTAssertEqual(geometry.highlightOffset.x, -5.01, accuracy: accuracy)
        XCTAssertEqual(geometry.highlightOffset.y, -5.845, accuracy: accuracy)
    }

    func testFillScaleMatchesWebBoundariesAndMidpoint() {
        XCTAssertEqual(SliccAgentAvatarGeometry.fillScale(for: 50), 1, accuracy: accuracy)
        XCTAssertEqual(SliccAgentAvatarGeometry.fillScale(for: 67.5), 1.6, accuracy: accuracy)
        XCTAssertEqual(SliccAgentAvatarGeometry.fillScale(for: 85), 2.2, accuracy: accuracy)
    }

    func testMaxTravelClampsAtBothBounds() {
        let lowFill = SliccAgentAvatarGeometry(
            type: .cone, color: "#F59E0B", fill: 0, sideLength: 100)
        let highFill = SliccAgentAvatarGeometry(
            type: .scoop, color: "#F97316", fill: 100, sideLength: 100)
        let midpoint = SliccAgentAvatarGeometry(
            type: .scoop, color: "#8B5CF6", fill: 67.5, sideLength: 100)

        XCTAssertEqual(lowFill.maxPupilTravel, 14.8, accuracy: accuracy)
        XCTAssertEqual(highFill.maxPupilTravel, 1.9, accuracy: accuracy)
        XCTAssertEqual(midpoint.maxPupilTravel, 4.78, accuracy: accuracy)
    }

    func testPupilOffsetUsesRadialMaxTravelClamp() {
        let geometry = SliccAgentAvatarGeometry(
            type: .scoop, color: "#8B5CF6", fill: 67.5, sideLength: 100)

        XCTAssertEqual(geometry.clampedPupilOffset(.init(x: 1, y: 2)), .init(x: 1, y: 2))
        let clamped = geometry.clampedPupilOffset(.init(x: 30, y: 40))
        XCTAssertEqual(clamped.x, 2.868, accuracy: accuracy)
        XCTAssertEqual(clamped.y, 3.824, accuracy: accuracy)
        XCTAssertEqual(hypot(clamped.x, clamped.y), geometry.maxPupilTravel, accuracy: accuracy)
    }

    func testInputsClampToSupportedRanges() {
        let geometry = SliccAgentAvatarGeometry(
            type: .cone, color: "#D2691E", fill: 120, sideLength: -26)
        XCTAssertEqual(geometry.fill, 100)
        XCTAssertEqual(geometry.sideLength, 0)
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

    func testTiltDirectionSignsMatchScreenCoordinates() {
        let offset = tiltMapping.pupilOffset(
            for: .init(roll: 0.1, pitch: 0.2), geometry: tiltGeometry,
            reduceMotion: false, isDeviceMotionAvailable: true)

        XCTAssertGreaterThan(offset.x, 0)
        XCTAssertLessThan(offset.y, 0)
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

    func testTiltControllerStartsOnceAndPublishesSmoothedOffset() {
        let source = FixedSliccAgentAvatarTiltSource(roll: 0.2, pitch: 0.1)
        let controller = SliccAgentAvatarTiltController(source: source)

        controller.update(geometry: tiltGeometry, motionDisabled: false)

        XCTAssertEqual(source.startCallCount, 1)
        XCTAssertGreaterThan(controller.pupilOffset.x, 0)
        XCTAssertLessThan(controller.pupilOffset.y, 0)
        XCTAssertGreaterThan(hypot(controller.pupilOffset.x, controller.pupilOffset.y), 0)
    }

    func testTiltControllerDoesNotStartTwiceWhileUpdating() {
        let source = FixedSliccAgentAvatarTiltSource(roll: 0.2, pitch: 0.1)
        let controller = SliccAgentAvatarTiltController(source: source)

        controller.update(geometry: tiltGeometry, motionDisabled: false)
        controller.update(geometry: tiltGeometry, motionDisabled: false)

        XCTAssertEqual(source.startCallCount, 1)
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
        for eyes in [SliccAgentAvatarGeometry.EyeState.dead, .none] {
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
}
