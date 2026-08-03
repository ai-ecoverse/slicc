import CoreGraphics
import XCTest

@testable import SliccFollower

/// The parser that lets lucide's `d` strings ship verbatim. Correctness here
/// is what keeps a ported glyph from silently becoming a smear, so the tests
/// assert on the geometry the commands are supposed to produce rather than
/// on "did it parse".
final class SVGPathTests: XCTestCase {

    /// Sampling the bounding box is the cheapest ground truth for "the pen
    /// went where the command said".
    private func bounds(_ data: String) -> CGRect {
        SVGPath.parse(data).boundingBoxOfPath
    }

    func testAbsoluteMoveAndLine() {
        let box = bounds("M 2 4 L 10 16")
        XCTAssertEqual(box.minX, 2, accuracy: 0.001)
        XCTAssertEqual(box.minY, 4, accuracy: 0.001)
        XCTAssertEqual(box.maxX, 10, accuracy: 0.001)
        XCTAssertEqual(box.maxY, 16, accuracy: 0.001)
    }

    func testRelativeCommandsAccumulate() {
        let box = bounds("m 1 1 l 2 2 l 2 2")
        XCTAssertEqual(box.maxX, 5, accuracy: 0.001, "relative segments must chain, not reset")
        XCTAssertEqual(box.maxY, 5, accuracy: 0.001)
    }

    func testRepeatedPairsAfterMovetoAreImplicitLinetos() {
        // Per the SVG spec; lucide relies on it, e.g. `m7 11 4.08 10.35 …`.
        XCTAssertEqual(bounds("M 0 0 4 0 4 4"), bounds("M 0 0 L 4 0 L 4 4"))
    }

    func testHorizontalAndVerticalShorthand() {
        let box = bounds("M 0 0 H 8 V 6")
        XCTAssertEqual(box.width, 8, accuracy: 0.001)
        XCTAssertEqual(box.height, 6, accuracy: 0.001)
    }

    func testNegativeNumbersNeedNoSeparator() {
        // `4-3` is two numbers in path data — splitting on whitespace loses this.
        XCTAssertEqual(bounds("M0 0L4-3"), bounds("M 0 0 L 4 -3"))
    }

    func testDecimalsPackedWithoutSeparators() {
        XCTAssertEqual(bounds("M.5.5L1.5 2.5"), bounds("M 0.5 0.5 L 1.5 2.5"))
    }

    func testSemicircleArcSpansItsDiameter() {
        // A half-circle of radius 5 from (0,0) to (10,0). SVG's y axis points
        // down, so sweep=1 (positive angle direction) bulges to NEGATIVE y.
        let box = bounds("M 0 0 A 5 5 0 0 1 10 0")
        XCTAssertEqual(box.minX, 0, accuracy: 0.01)
        XCTAssertEqual(box.maxX, 10, accuracy: 0.01)
        XCTAssertEqual(box.minY, -5, accuracy: 0.05, "sweep=1 must curve to -y")
        XCTAssertEqual(box.maxY, 0, accuracy: 0.05)
    }

    func testArcSweepFlagFlipsTheBulge() {
        let box = bounds("M 0 0 A 5 5 0 0 0 10 0")
        XCTAssertEqual(box.maxY, 5, accuracy: 0.05, "sweep=0 must curve to +y")
        XCTAssertEqual(box.minY, 0, accuracy: 0.05)
    }

    func testUndersizedArcRadiiAreScaledUpToReachTheEndpoint() {
        // Radius 1 cannot span a chord of 10; the spec says scale, not fail.
        let box = bounds("M 0 0 A 1 1 0 0 1 10 0")
        XCTAssertEqual(box.maxX, 10, accuracy: 0.01)
        XCTAssertEqual(box.minY, -5, accuracy: 0.1)
    }

    func testZeroRadiusArcDegradesToALine() {
        XCTAssertEqual(bounds("M 0 0 A 0 0 0 0 1 6 8"), bounds("M 0 0 L 6 8"))
    }

    func testArcFlagsMayBeWrittenUnseparated() {
        // Lucide emits `a3.5 3.5 0 1 1 6.71 0`, but `011` is equally legal.
        XCTAssertEqual(bounds("M0 0a5 5 0 116 0"), bounds("M 0 0 a 5 5 0 1 1 6 0"))
    }

    func testSmoothCubicReflectsThePreviousControlPoint() {
        let reflected = bounds("M 0 0 C 0 4 4 4 4 0 S 8 -4 8 0")
        let explicit = bounds("M 0 0 C 0 4 4 4 4 0 C 4 -4 8 -4 8 0")
        XCTAssertEqual(reflected.minY, explicit.minY, accuracy: 0.001)
        XCTAssertEqual(reflected.maxY, explicit.maxY, accuracy: 0.001)
    }

    func testClosePathReturnsToTheSubpathStart() {
        let box = bounds("M 2 2 L 6 2 L 6 6 Z")
        XCTAssertEqual(box.minX, 2, accuracy: 0.001)
        XCTAssertEqual(box.minY, 2, accuracy: 0.001)
    }

    func testTrailingCloseWithoutACommandTerminates() {
        // A malformed repeat would spin forever: `Z` consumes no operands.
        XCTAssertFalse(bounds("M 0 0 L 4 4 Z 1 2").isNull)
    }

    func testGarbageYieldsAnEmptyPathInsteadOfCrashing() {
        XCTAssertTrue(SVGPath.parse("wat").isEmpty)
        XCTAssertTrue(SVGPath.parse("").isEmpty)
        XCTAssertTrue(SVGPath.parse("M").isEmpty, "a moveto with no operands draws nothing")
    }

    // MARK: - Framing

    func testGlyphIsScaledAndCenteredInTheTargetRect() {
        // The full 24-unit box mapped into a 48pt square doubles in size.
        let rect = CGRect(x: 0, y: 0, width: 48, height: 48)
        let box = SVGPath.path(from: "M 0 0 L 24 24", in: rect).boundingBoxOfPath
        XCTAssertEqual(box.minX, 0, accuracy: 0.001)
        XCTAssertEqual(box.maxX, 48, accuracy: 0.001)
    }

    func testNonSquareRectPreservesAspectAndCenters() {
        let rect = CGRect(x: 0, y: 0, width: 100, height: 50)
        let box = SVGPath.path(from: "M 0 0 L 24 24", in: rect).boundingBoxOfPath
        XCTAssertEqual(box.width, 50, accuracy: 0.001, "scaled by the short side")
        XCTAssertEqual(box.minX, 25, accuracy: 0.001, "centered on the long side")
    }

    // MARK: - The shipped glyphs

    func testEveryPortedLucideGlyphParsesAndFillsItsBox() {
        for glyph in LucideGlyph.allCases {
            var combined = CGRect.null
            for data in glyph.pathData {
                let box = SVGPath.parse(data).boundingBoxOfPath
                XCTAssertFalse(
                    box.isNull || box.isEmpty, "\(glyph.rawValue) has an unparsed subpath")
                combined = combined.union(box)
            }
            // Lucide draws to a 24x24 box with ~2 units of padding; a glyph
            // that came out tiny means the parser dropped commands.
            XCTAssertGreaterThan(
                combined.width, 10, "\(glyph.rawValue) is too narrow to be intact")
            XCTAssertGreaterThan(
                combined.height, 10, "\(glyph.rawValue) is too short to be intact")
            XCTAssertGreaterThanOrEqual(combined.minX, -0.5, "\(glyph.rawValue) overflows left")
            XCTAssertLessThanOrEqual(combined.maxX, 24.5, "\(glyph.rawValue) overflows right")
            XCTAssertGreaterThanOrEqual(combined.minY, -0.5, "\(glyph.rawValue) overflows top")
            XCTAssertLessThanOrEqual(combined.maxY, 24.5, "\(glyph.rawValue) overflows bottom")
        }
    }
}
