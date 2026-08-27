import Foundation
import SwiftUI
import XCTest

@testable import SliccWidgetKit

/// Pins the avatar geometry against the app's.
///
/// `UnitAvatarGeometry` is a hand-carried static port of
/// `SliccAgentAvatarGeometry` in `packages/ios-app` — the two cannot share
/// code today (the app's version drags in the expression engine, CoreMotion
/// tilt and the noise field, none of which exist in a widget process). These
/// expectations are what makes the drift visible: if a number here changes,
/// the avatar on the home screen has stopped being the avatar in the app.
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

    /// The cone zooms harder (3 vs 2.65) into a band pulled ABOVE the tile.
    /// Hard-coding the scoop's numbers for both is the bug the app's exhaustive
    /// switch exists to prevent, so both types are pinned here.
    func testEachTypeLandsItsOwnBand() {
        XCTAssertEqual(cone().eyeRadius, 39.9, accuracy: 0.01)
        XCTAssertEqual(scoop().eyeRadius, 35.245, accuracy: 0.01)
        XCTAssertEqual(cone().eyeOutlineWidth, 4.2, accuracy: 0.01)
        XCTAssertEqual(scoop().eyeOutlineWidth, 3.71, accuracy: 0.01)
    }

    /// Eyes sit past the tile edge and are cropped by the roundrect — that is
    /// the avatar's whole look, not a bug to "fix" by pulling them inward.
    func testEyesAreDeliberatelyCroppedByTheTile() {
        let coneEyes = cone().eyeCenters
        XCTAssertEqual(coneEyes[0].x, 2.75, accuracy: 0.000_001)
        XCTAssertEqual(coneEyes[1].x, 97.25, accuracy: 0.000_001)
        XCTAssertEqual(coneEyes[0].y, 50, accuracy: 0.01)

        // These four are byte-for-byte the values `SliccAgentAvatarGeometryTests`
        // pins in the app, which is what makes this suite a parity check
        // rather than a restatement of this file's own arithmetic.
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

    /// Fullness is pupil size and nothing else — no ring, gauge, badge or
    /// number ever joins it on the tile.
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

    // MARK: Lifecycle → face

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

    /// A broken unit is idle by the letter of the lifecycle and the loudest
    /// thing on the tile by intent. Dimming it would invert the whole point.
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

    // MARK: Identity hue

    func testAConeIsAlwaysWaffleBrown() {
        XCTAssertEqual(WidgetUnit(id: "a", name: "Sliccy", role: .cone).avatarColorHex, "#b07823")
        XCTAssertEqual(WidgetUnit(id: "b", name: "Nightly", role: .cone).avatarColorHex, "#b07823")
    }

    /// Mirrors the leader's `scoopColor`, so a scoop wears the same colour in
    /// the tab strip, the transcript and the widget.
    func testScoopHueIsStableAndDrawnFromTheSixColourPalette() {
        let palette = Set(["#06b6d4", "#8b5cf6", "#f59e0b", "#10b981", "#3b82f6", "#ef4444"])
        for name in ["boy-scout", "memory-curator", "esp32-toolchain", "", "🍦"] {
            let hue = WidgetUnit(id: "x", name: name, role: .scoop).avatarColorHex
            XCTAssertTrue(palette.contains(hue), "\(name) produced \(hue)")
        }
        // Same name, same colour — the property the whole scheme rests on.
        XCTAssertEqual(
            WidgetUnit(id: "1", name: "boy-scout", role: .scoop).avatarColorHex,
            WidgetUnit(id: "2", name: "boy-scout", role: .scoop).avatarColorHex)
        // The hash follows JS `charCodeAt(0)`: astral scalars contribute their
        // HIGH surrogate only, so this value is a wire-compatibility fact.
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

/// The face IS the status channel — there is no word beside it to fall back
/// on. These are the checks that keep two phases from collapsing into one
/// picture.
final class UnitAvatarFaceTests: XCTestCase {
    private func face(_ lifecycle: WidgetUnit.Lifecycle, _ activity: WidgetUnit.Activity? = nil) -> UnitAvatarFace {
        WidgetUnit(id: "a", name: "A", role: .scoop, lifecycle: lifecycle, activity: activity).avatarFace
    }

    /// Only tool work squares the eyes up (`AvatarExpression.shapeTarget`).
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

    /// Awaiting makes eye contact — the user IS the target on a phone — and
    /// carries the soft arrival lid. That lid is the only thing separating it
    /// from a tool call in a still frame, so it must not be zero.
    func testAwaitingHoldsEyeContactUnderASoftLid() {
        XCTAssertNil(face(.idle, .awaiting).gaze, "dead ahead")
        XCTAssertGreaterThan(face(.idle, .awaiting).lidTop, UnitAvatarGeometry.lidLineEpsilon)
        XCTAssertEqual(face(.working, .tool).lidTop, 0)
    }

    /// Broken and initializing keep their own eye treatments and carry no
    /// expression at all, exactly as `ScoopSummary.avatarActivity` decides.
    func testTheTwoEyeTreatmentsCarryNoExpression() {
        XCTAssertEqual(face(.broken), .resting)
        XCTAssertEqual(face(.initializing), .resting)
    }

    /// Every phase must be a DIFFERENT picture. If two of these collide the
    /// widget has stopped saying anything.
    func testEveryPhaseIsADistinctPose() {
        let poses = [
            face(.working, .tool), face(.working, .thinking),
            face(.idle, .awaiting), face(.idle, nil),
        ]
        XCTAssertEqual(Set(poses.map { "\($0.shape)|\($0.lidTop)|\(String(describing: $0.gaze))|\($0.brows != nil)" }).count, 4)
    }

    // MARK: Gaze clamp

    /// A nearly-full context grows the pupil past the socket, and at that
    /// point there is nowhere left to look. Without the clamp the pupil walks
    /// out through the white (`AvatarExpression.travelClamp`).
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

    // MARK: Shape channel

    func testASquaredSocketIsSmallerCorneredThanACircle() {
        let round = UnitAvatarGeometry(type: .scoop, face: .thinking, sideLength: 100)
        let square = UnitAvatarGeometry(type: .scoop, face: .tool, sideLength: 100)
        XCTAssertEqual(round.socketCornerRadius, round.eyeRadius, accuracy: 0.001)
        XCTAssertLessThan(square.socketCornerRadius, round.socketCornerRadius / 3)
        XCTAssertEqual(square.pupilCornerRadius, square.pupilRadius * 0.22, accuracy: 0.001)
    }

    // MARK: Lids and brows

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

    /// The brows overhang the tile's top edge, exactly as they do in the app —
    /// the host pads by `maximumBrowOverhang` instead of clipping them.
    ///
    /// The first attempt squeezed them into the headroom between the tile edge
    /// and the socket. On glass that failed: at a 0.269 corner radius there is
    /// no straight edge that high, so the capsule ran into the rounded corner
    /// and came out as a black wedge sliced off at an angle.
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
                // The x IS clamped: unlike the app, the next cell is a few
                // points away, so a brow may not hang off the side.
                XCTAssertGreaterThanOrEqual(center.x - geometry.browSize.x / 2, -0.001)
                XCTAssertLessThanOrEqual(
                    center.x + geometry.browSize.x / 2, geometry.sideLength + 0.001)
            }
        }
    }

    /// A face with no brows reserves nothing; a host still pads every cell by
    /// the maximum so a thinking unit does not sit lower than the idle one
    /// beside it.
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

    /// A brow still belongs to ITS eye: the left one stays left of centre.
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

    // MARK: TV static

    /// Frozen, never time-derived: a widget redraws on WidgetKit's schedule,
    /// and static that reshuffles every few hours reads as a rendering bug.
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
