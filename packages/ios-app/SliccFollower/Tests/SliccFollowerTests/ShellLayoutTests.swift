import SwiftUI
import XCTest

@testable import SliccFollower

final class ShellLayoutTests: XCTestCase {

    func testLayoutHasExactlyTwoModes() {
        XCTAssertEqual(ShellLayoutMode.allCases, [.compactOverlay, .regularSplit])
    }

    func testBreakpointIsInclusiveForCompactOverlay() {
        XCTAssertEqual(mode(width: 559), .compactOverlay)
        XCTAssertEqual(mode(width: 560), .compactOverlay)
        XCTAssertEqual(mode(width: 561), .regularSplit)
    }

    func testCompactSizeClassAlwaysUsesOverlay() {
        XCTAssertEqual(mode(sizeClass: .compact, width: 1_024), .compactOverlay)
        XCTAssertEqual(mode(sizeClass: nil, width: 1_024), .compactOverlay)
    }

    func testRepresentativeMultitaskingWidths() {
        let cases: [(String, UserInterfaceSizeClass, CGFloat, ShellLayoutMode)] = [
            ("iPhone portrait", .compact, 393, .compactOverlay),
            ("Slide Over", .compact, 320, .compactOverlay),
            ("one-third Split View", .compact, 375, .compactOverlay),
            ("one-half Split View", .compact, 507, .compactOverlay),
            ("wide one-half Split View", .regular, 683, .regularSplit),
            ("iPad full-screen portrait", .regular, 768, .regularSplit),
            ("iPad full-screen landscape", .regular, 1_024, .regularSplit),
        ]

        for (name, sizeClass, width, expected) in cases {
            XCTAssertEqual(
                mode(sizeClass: sizeClass, width: width), expected,
                "\(name) at \(width) points should use \(expected)")
        }
    }

    private func mode(
        sizeClass: UserInterfaceSizeClass? = .regular,
        width: CGFloat
    ) -> ShellLayoutMode {
        ShellLayout.mode(horizontalSizeClass: sizeClass, availableWidth: width)
    }
}
