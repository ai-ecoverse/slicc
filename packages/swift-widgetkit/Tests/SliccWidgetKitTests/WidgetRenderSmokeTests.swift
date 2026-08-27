import Foundation
import SwiftUI
import XCTest

@testable import SliccWidgetKit

/// Draws every family against every fixture in both schemes.
///
/// A widget view that traps takes the whole tile down to a blank grey square
/// on someone's home screen, with no console and no crash report they will
/// ever see. Rendering here is the only place that failure mode is cheap: the
/// suite asserts the tile is non-empty, which is enough to catch a nil unwrap,
/// an infinite layout or an empty `ViewBuilder` branch.
@MainActor
final class WidgetRenderSmokeTests: XCTestCase {
    /// iPhone widget point sizes; macOS runs a few points narrower per family.
    private static let families: [(name: String, size: CGSize, view: (WidgetRenderContext) -> AnyView)] = [
        ("small", CGSize(width: 158, height: 158), { AnyView(UnitsWidgetSmall(context: $0)) }),
        ("medium", CGSize(width: 338, height: 158), { AnyView(UnitsWidgetMedium(context: $0)) }),
        ("large", CGSize(width: 338, height: 354), { AnyView(UnitsWidgetLarge(context: $0)) }),
    ]

    private func renderedSize(
        _ view: some View, size: CGSize, scheme: ColorScheme
    ) -> CGSize? {
        let renderer = ImageRenderer(
            content:
                view
                .environment(\.colorScheme, scheme)
                .frame(width: size.width, height: size.height)
        )
        renderer.scale = 2
        return renderer.cgImage.map { CGSize(width: $0.width, height: $0.height) }
    }

    func testEveryFamilyDrawsEveryFixtureInBothSchemes() {
        for (fixtureName, snapshot) in WidgetSnapshot.allFixtures {
            for scheme in [ColorScheme.light, .dark] {
                let context = WidgetRenderContext(
                    snapshot: snapshot,
                    now: WidgetSnapshot.fixtureCaptureDate.addingTimeInterval(240),
                    host: .follower)
                for family in Self.families {
                    let rendered = renderedSize(
                        family.view(context), size: family.size, scheme: scheme)
                    XCTAssertEqual(
                        rendered, CGSize(width: family.size.width * 2, height: family.size.height * 2),
                        "\(family.name)/\(fixtureName)/\(scheme) failed to render")
                }
            }
        }
    }

    /// The entry view is what WidgetKit actually instantiates, container
    /// background and tap route included.
    func testTheEntryViewDrawsForBothHosts() {
        for host in [WidgetHost.follower, .sliccstart] {
            let context = WidgetRenderContext(
                snapshot: .fixtureBusy, now: WidgetSnapshot.fixtureCaptureDate, host: host)
            XCTAssertNotNil(
                renderedSize(
                    UnitsWidgetEntryView(context: context),
                    size: CGSize(width: 338, height: 158), scheme: .dark))
        }
    }

    /// A cone-less snapshot is what a follower holds between `connect` and the
    /// first `scoops.list` — every family has to survive it.
    func testAConnectedInstanceWithNoConeStillDraws() {
        let context = WidgetRenderContext(
            snapshot: WidgetSnapshot(
                instanceLabel: "x", runtime: nil, connection: .connected,
                capturedAt: WidgetSnapshot.fixtureCaptureDate, units: []),
            now: WidgetSnapshot.fixtureCaptureDate, host: .follower)
        for family in Self.families {
            XCTAssertNotNil(
                renderedSize(family.view(context), size: family.size, scheme: .light),
                "\(family.name) cannot draw a connected instance with no cone")
        }
    }

    /// More units than any family lists, to prove the caps clip rather than
    /// overflow the tile.
    func testAnAbsurdUnitCountStillDraws() {
        let units =
            [WidgetUnit(id: "cone", name: "Sliccy", role: .cone, lifecycle: .working, isActive: true)]
            + (0..<40).map {
                WidgetUnit(
                    id: "s\($0)", name: "scoop-with-a-fairly-long-slug-\($0)", role: .scoop,
                    parentId: "cone", lifecycle: .working, activity: .tool, fill: Double($0 % 100))
            }
        let context = WidgetRenderContext(
            snapshot: WidgetSnapshot(
                instanceLabel: "x", connection: .connected,
                capturedAt: WidgetSnapshot.fixtureCaptureDate, units: units),
            now: WidgetSnapshot.fixtureCaptureDate, host: .follower)
        for family in Self.families {
            XCTAssertNotNil(renderedSize(family.view(context), size: family.size, scheme: .dark))
        }
    }

    /// The outline marks only reach a screen on the iOS lock screen, which
    /// this suite cannot render — so draw them here instead. A mark that
    /// traps would otherwise take out the accessory family and nothing else.
    func testTheOutlineMarksDraw() {
        for role in [WidgetUnit.Role.cone, .scoop] {
            XCTAssertNotNil(
                renderedSize(
                    UnitMarkView(role: role, size: 32).foregroundStyle(.black),
                    size: CGSize(width: 32, height: 32), scheme: .light))
        }
    }

    /// Every face, drawn once, at the size a small tile gives it. A pose that
    /// traps takes the whole widget down to a blank grey square.
    func testEveryFaceDraws() {
        let faces: [(String, WidgetUnit)] = [
            ("thinking", WidgetUnit(id: "1", name: "a", role: .cone, lifecycle: .working, activity: .thinking, fill: 30)),
            ("tool", WidgetUnit(id: "2", name: "a", role: .scoop, lifecycle: .working, activity: .tool, fill: 99)),
            ("awaiting", WidgetUnit(id: "3", name: "a", role: .scoop, lifecycle: .idle, activity: .awaiting)),
            ("idle", WidgetUnit(id: "4", name: "a", role: .cone, lifecycle: .idle, fill: 0)),
            ("broken", WidgetUnit(id: "5", name: "a", role: .scoop, lifecycle: .broken, fill: 85)),
            ("booting", WidgetUnit(id: "6", name: "a", role: .cone, lifecycle: .initializing)),
        ]
        for (label, unit) in faces {
            for size in [16.0, 34.0, 104.0] {
                XCTAssertNotNil(
                    renderedSize(
                        UnitAvatarView(
                            geometry: unit.avatarGeometry(sideLength: size),
                            hue: WidgetPalette.dark.avatarHue(for: unit),
                            muted: unit.isDormant),
                        size: CGSize(width: size, height: size), scheme: .dark),
                    "\(label) at \(size)pt failed to render")
            }
        }
    }

    /// The large family's message block: an agent turn, a user turn, a turn
    /// from a unit that has left the snapshot, and a session with nothing said
    /// at all. All four reach a real home screen.
    func testTheMessageBlockDrawsEveryAttribution() {
        let snapshots: [(String, WidgetSnapshot)] = [
            ("agent", .fixtureBusy),
            ("user", .fixtureCrowded),
            ("silent", .fixtureStarting),
            (
                "orphaned",
                WidgetSnapshot(
                    instanceLabel: "x", connection: .connected,
                    capturedAt: WidgetSnapshot.fixtureCaptureDate,
                    units: [WidgetUnit(id: "c", name: "C", role: .cone, lifecycle: .idle)],
                    lastMessage: WidgetMessage(
                        author: .agent, unitId: "gone",
                        text: String(repeating: "long ", count: 80)))
            ),
        ]
        for (label, snapshot) in snapshots {
            let context = WidgetRenderContext(
                snapshot: snapshot, now: WidgetSnapshot.fixtureCaptureDate, host: .follower)
            XCTAssertNotNil(
                renderedSize(
                    UnitsWidgetLarge(context: context),
                    size: CGSize(width: 338, height: 354), scheme: .dark),
                "\(label) failed to render")
        }
    }

    /// The empty state's TV static goes through a `Canvas`, which nothing else
    /// in the package does.
    func testTheTvStaticDraws() {
        XCTAssertNotNil(
            renderedSize(
                UnitAvatarView(
                    geometry: UnitAvatarGeometry(type: .cone, eyes: .static, sideLength: 56),
                    hue: WidgetPalette.dark.inkTertiary),
                size: CGSize(width: 56, height: 56), scheme: .dark))
    }

    func testBothMarksProduceANonEmptyPath() {
        let rect = CGRect(x: 0, y: 0, width: 24, height: 24)
        XCTAssertFalse(ConeMark().path(in: rect).isEmpty)
        XCTAssertFalse(ScoopMark().path(in: rect).isEmpty)
        // Fitted into a non-square rect the 24-unit BOX stays square and
        // centred. The cone's ink only spans 10 of those units (lucide draws
        // it x 7...17), which is why it reads narrower than the scoop at the
        // same `size` — same as in the app, where both come off the same box.
        let wide = ConeMark().path(in: CGRect(x: 0, y: 0, width: 100, height: 24)).boundingRect
        XCTAssertEqual(wide.width, 10, accuracy: 0.5)
        XCTAssertEqual(wide.midX, 50, accuracy: 0.5)
        XCTAssertEqual(
            ScoopMark().path(in: CGRect(x: 0, y: 0, width: 24, height: 24)).boundingRect.midX,
            12, accuracy: 0.5)
    }

    /// A healthy connection says nothing; everything else gets a pip.
    func testConnectionPipIsAbsentOnlyWhenHealthy() {
        let palette = WidgetPalette.dark
        XCTAssertNil(palette.connectionColor(.connected))
        XCTAssertEqual(palette.connectionColor(.stalled), palette.warn)
        XCTAssertEqual(palette.connectionColor(.disconnected), palette.inkTertiary)
        XCTAssertEqual(palette.connectionColor(.none), palette.inkTertiary)
    }
}
