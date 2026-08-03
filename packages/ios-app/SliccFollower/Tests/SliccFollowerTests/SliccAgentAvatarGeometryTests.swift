import XCTest

@testable import SliccFollower

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
}
