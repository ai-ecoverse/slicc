import Foundation
import SwiftUI
import XCTest

@testable import SliccWidgetKit









final class UnitAvatarGeometryTests: XCTestCase {
    private func cone(side: Double = 100, fill: Double? = nil) -> UnitAvatarGeometry {
        UnitAvatarGeometry(type: .cone, fill: fill, sideLength: side)
    }

    private func scoop(side: Double = 100, fill: Double? = nil) -> UnitAvatarGeometry {
        UnitAvatarGeometry(type: .scoop, fill: fill, sideLength: side)
    }

    func testTileCornerRadiusIsTheWebSuperellipseRatio() {
        XCTAssertEqual(cone(side: 26).tileCornerRadius, 0.269 * 26, accuracy: 0.0001)
    }

    
    
    
    func testEachTypeLandsItsOwnBand() {
        XCTAssertEqual(cone().eyeRadius, 39.9, accuracy: 0.01)
        XCTAssertEqual(scoop().eyeRadius, 35.245, accuracy: 0.01)
        XCTAssertEqual(cone().eyeOutlineWidth, 4.2, accuracy: 0.01)
        XCTAssertEqual(scoop().eyeOutlineWidth, 3.71, accuracy: 0.01)
    }

    
    
    func testEyesAreDeliberatelyCroppedByTheTile() {
        let coneEyes = cone().eyeCenters
        XCTAssertEqual(coneEyes[0].x, 2.75, accuracy: 0.000_001)
        XCTAssertEqual(coneEyes[1].x, 97.25, accuracy: 0.000_001)
        XCTAssertEqual(coneEyes[0].y, 50, accuracy: 0.01)

        
        
        
        let scoopEyes = scoop().eyeCenters
        XCTAssertEqual(scoopEyes[0].x, 8.2625, accuracy: 0.000_001)
        XCTAssertEqual(scoopEyes[1].x, 91.7375, accuracy: 0.000_001)
        XCTAssertEqual(scoopEyes[0].y, 50, accuracy: 0.01)

        XCTAssertGreaterThan(
            cone().eyeRadius, coneEyes[0].x,
            "the left eye must overhang the tile's left edge")
    }

    func testEyesAreSymmetricAboutTheTileCentre() {
        for geometry in [cone(), scoop()] {
            let centers = geometry.eyeCenters
            XCTAssertEqual(
                centers[0].x + centers[1].x, geometry.sideLength, accuracy: 0.01)
        }
    }

    
    
    func testPupilGrowsWithContextFillOnTheAppsCurve() {
        XCTAssertEqual(UnitAvatarGeometry.fillToPupilScale(nil), 1)
        XCTAssertEqual(UnitAvatarGeometry.fillToPupilScale(0), 1)
        XCTAssertEqual(UnitAvatarGeometry.fillToPupilScale(50), 1)
        XCTAssertEqual(UnitAvatarGeometry.fillToPupilScale(67.5), 1.6, accuracy: 0.0001)
        XCTAssertEqual(UnitAvatarGeometry.fillToPupilScale(85), 2.2)
        XCTAssertEqual(UnitAvatarGeometry.fillToPupilScale(100), 2.2)
        XCTAssertEqual(UnitAvatarGeometry.fillToPupilScale(-5), 1)

        XCTAssertEqual(cone(fill: 100).pupilRadius, cone(fill: 20).pupilRadius * 2.2, accuracy: 0.01)
    }

    func testHighlightSitsUpAndLeftOfThePupil() {
        let geometry = cone(fill: 40)
        XCTAssertEqual(geometry.highlightRadius, 0.4 * geometry.pupilRadius, accuracy: 0.0001)
        XCTAssertLessThan(geometry.highlightOffset.x, 0)
        XCTAssertLessThan(geometry.highlightOffset.y, 0)
    }

    func testGeometryScalesLinearlyWithSide() {
        XCTAssertEqual(cone(side: 52).eyeRadius, cone(side: 26).eyeRadius * 2, accuracy: 0.0001)
        XCTAssertEqual(cone(side: 52).blobSize.x, cone(side: 26).blobSize.x * 2, accuracy: 0.0001)
    }

    func testANegativeSideCannotProduceANegativeTile() {
        XCTAssertEqual(UnitAvatarGeometry(type: .cone, sideLength: -10).sideLength, 0)
    }

    

    func testEyeTreatmentFollowsTheLifecycleTheAppUses() {
        func eyes(_ lifecycle: WidgetUnit.Lifecycle) -> UnitAvatarGeometry.EyeState {
            WidgetUnit(id: "a", name: "A", role: .scoop, lifecycle: lifecycle).avatarEyes
        }
        XCTAssertEqual(eyes(.broken), .dead)
        XCTAssertEqual(eyes(.initializing), .none)
        XCTAssertEqual(eyes(.working), .open)
        XCTAssertEqual(eyes(.idle), .open)
        XCTAssertEqual(eyes(.unknown), .open)
    }

    
    
    func testOnlyTrulyQuietUnitsRecede() {
        func dormant(_ lifecycle: WidgetUnit.Lifecycle) -> Bool {
            WidgetUnit(id: "a", name: "A", role: .scoop, lifecycle: lifecycle).isDormant
        }
        XCTAssertTrue(dormant(.idle))
        XCTAssertTrue(dormant(.unknown))
        XCTAssertFalse(dormant(.broken))
        XCTAssertFalse(dormant(.working))
        XCTAssertFalse(dormant(.initializing))
    }

    

    func testAConeIsAlwaysWaffleBrown() {
        XCTAssertEqual(WidgetUnit(id: "a", name: "Sliccy", role: .cone).avatarColorHex, "#b07823")
        XCTAssertEqual(WidgetUnit(id: "b", name: "Nightly", role: .cone).avatarColorHex, "#b07823")
    }

    
    
    func testScoopHueIsStableAndDrawnFromTheSixColourPalette() {
        let palette = Set(["#06b6d4", "#8b5cf6", "#f59e0b", "#10b981", "#3b82f6", "#ef4444"])
        for name in ["boy-scout", "memory-curator", "esp32-toolchain", "", "🍦"] {
            let hue = WidgetUnit(id: "x", name: name, role: .scoop).avatarColorHex
            XCTAssertTrue(palette.contains(hue), "\(name) produced \(hue)")
        }
        
        XCTAssertEqual(
            WidgetUnit(id: "1", name: "boy-scout", role: .scoop).avatarColorHex,
            WidgetUnit(id: "2", name: "boy-scout", role: .scoop).avatarColorHex)
        
        
        XCTAssertEqual(WidgetUnit(id: "x", name: "boy-scout", role: .scoop).avatarColorHex, "#ef4444")
    }

    func testEveryHueParsesIntoAColour() {
        for unit in WidgetSnapshot.fixtureCrowded.units {
            XCTAssertNotNil(
                Color(cssHex: unit.avatarColorHex), "\(unit.name) hue is unparseable")
        }
        XCTAssertNotNil(Color(cssHex: "#abc"))
        XCTAssertNil(Color(cssHex: "abc123"))
        XCTAssertNil(Color(cssHex: "#zzzzzz"))
        XCTAssertNil(Color(cssHex: "#abcd"))
    }
}




final class UnitAvatarFaceTests: XCTestCase {
    private func face(_ lifecycle: WidgetUnit.Lifecycle, _ activity: WidgetUnit.Activity? = nil) -> UnitAvatarFace {
        WidgetUnit(id: "a", name: "A", role: .scoop, lifecycle: lifecycle, activity: activity).avatarFace
    }

    
    func testOnlyAToolCallSquaresTheEyes() {
        XCTAssertEqual(face(.working, .tool).shape, 1)
        XCTAssertEqual(face(.working, .thinking).shape, 0)
        XCTAssertEqual(face(.working, nil).shape, 0, "a turn always opens in thinking")
        XCTAssertEqual(face(.idle, .awaiting).shape, 0)
        XCTAssertEqual(face(.idle, nil).shape, 0)
    }

    func testThinkingIsTheOnlyPoseThatGrowsBrows() {
        XCTAssertNotNil(face(.working, .thinking).brows)
        XCTAssertNil(face(.working, .tool).brows)
        XCTAssertNil(face(.idle, .awaiting).brows)
        XCTAssertNil(face(.idle, nil).brows)
    }

    func testThinkingLooksUpAndAwayWhileIdleWandersLow() {
        let thinking = try? XCTUnwrap(face(.working, .thinking).gaze)
        XCTAssertLessThan(thinking!.y, UnitAvatarGeometry.bandEyeCenterY, "thinking looks up")
        let idle = try? XCTUnwrap(face(.idle, nil).gaze)
        XCTAssertGreaterThan(idle!.y, UnitAvatarGeometry.bandEyeCenterY, "idle wanders low")
    }

    
    
    
    func testAwaitingHoldsEyeContactUnderASoftLid() {
        XCTAssertNil(face(.idle, .awaiting).gaze, "dead ahead")
        XCTAssertGreaterThan(face(.idle, .awaiting).lidTop, UnitAvatarGeometry.lidLineEpsilon)
        XCTAssertEqual(face(.working, .tool).lidTop, 0)
    }

    
    
    func testTheTwoEyeTreatmentsCarryNoExpression() {
        XCTAssertEqual(face(.broken), .resting)
        XCTAssertEqual(face(.initializing), .resting)
    }

    
    
    func testEveryPhaseIsADistinctPose() {
        let poses = [
            face(.working, .tool), face(.working, .thinking),
            face(.idle, .awaiting), face(.idle, nil),
        ]
        XCTAssertEqual(Set(poses.map { "\($0.shape)|\($0.lidTop)|\(String(describing: $0.gaze))|\($0.brows != nil)" }).count, 4)
    }

    

    
    
    
    func testAFullContextWindowLeavesNoRoomToLook() {
        let roomy = UnitAvatarGeometry(type: .scoop, face: .idle, fill: 10, sideLength: 100)
        let full = UnitAvatarGeometry(type: .scoop, face: .idle, fill: 100, sideLength: 100)
        XCTAssertEqual(roomy.bandTravelClamp, UnitAvatarGeometry.bandMaxGazeOffset)
        XCTAssertEqual(full.bandTravelClamp, 2, "clamped to the floor, not to a negative")
        XCTAssertLessThan(
            hypot(full.pupilOffset(eyeIndex: 0).x, full.pupilOffset(eyeIndex: 0).y),
            hypot(roomy.pupilOffset(eyeIndex: 0).x, roomy.pupilOffset(eyeIndex: 0).y))
    }

    func testACentredGazeMovesNothing() {
        let geometry = UnitAvatarGeometry(type: .cone, face: .tool, sideLength: 100)
        XCTAssertEqual(geometry.pupilOffset(eyeIndex: 0), UnitAvatarGeometry.Point(x: 0, y: 0))
        XCTAssertEqual(geometry.pupilOffset(eyeIndex: 1), UnitAvatarGeometry.Point(x: 0, y: 0))
    }

    

    func testASquaredSocketIsSmallerCorneredThanACircle() {
        let round = UnitAvatarGeometry(type: .scoop, face: .thinking, sideLength: 100)
        let square = UnitAvatarGeometry(type: .scoop, face: .tool, sideLength: 100)
        XCTAssertEqual(round.socketCornerRadius, round.eyeRadius, accuracy: 0.001)
        XCTAssertLessThan(square.socketCornerRadius, round.socketCornerRadius / 3)
        XCTAssertEqual(square.pupilCornerRadius, square.pupilRadius * 0.22, accuracy: 0.001)
    }

    

    func testAnOpenLidIsParkedOffTheSocketEntirely() {
        let open = UnitAvatarGeometry(type: .scoop, face: .tool, sideLength: 100)
        XCTAssertFalse(open.lidIsVisible)
        XCTAssertFalse(open.lidLineIsVisible)
        XCTAssertEqual(open.lidInset, 0)

        let lidded = UnitAvatarGeometry(type: .scoop, face: .awaiting, sideLength: 100)
        XCTAssertTrue(lidded.lidIsVisible)
        XCTAssertTrue(lidded.lidLineIsVisible)
        XCTAssertEqual(lidded.lidInset, 0.1 * lidded.eyeDiameter, accuracy: 0.001)
    }

    
    
    
    
    
    
    
    func testBrowsOverhangTheTileRatherThanBeingSqueezedInside() {
        for type in [UnitAvatarGeometry.AvatarType.cone, .scoop] {
            let geometry = UnitAvatarGeometry(type: type, face: .thinking, sideLength: 100)
            let pose = try? XCTUnwrap(geometry.face.brows)
            XCTAssertGreaterThan(geometry.browOverhang, 0, "\(type) brows do not overhang")
            for index in 0...1 {
                let raise = index == 0 ? pose!.left.raise : pose!.right.raise
                let center = geometry.browCenter(eyeIndex: index, raise: raise)
                XCTAssertLessThan(
                    center.y + geometry.browHalfHeight,
                    geometry.eyeCenters[index].y - geometry.eyeRadius + geometry.eyeOutlineWidth,
                    "\(type) brow \(index) sits on the eyeball")
                
                
                XCTAssertGreaterThanOrEqual(center.x - geometry.browSize.x / 2, -0.001)
                XCTAssertLessThanOrEqual(
                    center.x + geometry.browSize.x / 2, geometry.sideLength + 0.001)
            }
        }
    }

    
    
    
    func testOnlyABrowedFaceOverhangsButHostsReserveTheMaximum() {
        let idle = UnitAvatarGeometry(type: .cone, face: .idle, sideLength: 100)
        XCTAssertEqual(idle.browOverhang, 0)
        let maximum = UnitAvatarGeometry.maximumBrowOverhang(sideLength: 100)
        XCTAssertGreaterThan(maximum, 0)
        for type in [UnitAvatarGeometry.AvatarType.cone, .scoop] {
            XCTAssertLessThanOrEqual(
                UnitAvatarGeometry(type: type, face: .thinking, sideLength: 100).browOverhang,
                maximum)
        }
        XCTAssertEqual(
            UnitAvatarGeometry.maximumBrowOverhang(sideLength: 200), maximum * 2, accuracy: 0.001)
    }

    
    func testEachBrowStaysOverItsOwnEye() {
        let geometry = UnitAvatarGeometry(type: .cone, face: .thinking, sideLength: 100)
        let pose = UnitAvatarFace.baseBrows
        XCTAssertLessThan(geometry.browCenter(eyeIndex: 0, raise: pose.left.raise).x, 50)
        XCTAssertGreaterThan(geometry.browCenter(eyeIndex: 1, raise: pose.right.raise).x, 50)
    }

    func testTheRaisedBrowIsHigherThanTheSettledOne() {
        let geometry = UnitAvatarGeometry(type: .scoop, face: .thinking, sideLength: 100)
        let pose = UnitAvatarFace.baseBrows
        XCTAssertLessThan(
            geometry.browCenter(eyeIndex: 0, raise: pose.left.raise).y,
            geometry.browCenter(eyeIndex: 1, raise: pose.right.raise).y,
            "the differential is what reads as quizzical")
    }

    

    
    
    func testTheStaticIsFrozenAndDiffersPerEye() {
        XCTAssertEqual(UnitAvatarView.noiseSeed(eyeIndex: 0), UnitAvatarView.noiseSeed(eyeIndex: 0))
        XCTAssertNotEqual(UnitAvatarView.noiseSeed(eyeIndex: 0), UnitAvatarView.noiseSeed(eyeIndex: 1))
    }

    func testTheNoiseGeneratorNeverGetsStuckOnZero() {
        var generator = AvatarNoiseGenerator(seed: 0)
        let first = generator.next()
        XCTAssertNotEqual(first, 0)
        XCTAssertNotEqual(generator.next(), first)
    }
}
