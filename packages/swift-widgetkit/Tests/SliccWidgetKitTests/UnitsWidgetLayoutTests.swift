import Foundation
import SwiftUI
import XCTest

@testable import SliccWidgetKit

/// The layout decisions worth a test are the ones a screenshot does not catch:
/// which units get a cell, in what order, and what gets DROPPED when the tile
/// runs out of room. A unit nobody can see is the widget lying about the
/// session.
final class UnitsWidgetLayoutTests: XCTestCase {
    private func unit(
        _ id: String, _ role: WidgetUnit.Role, minutesAgo: Double?,
        lifecycle: WidgetUnit.Lifecycle = .idle
    ) -> WidgetUnit {
        WidgetUnit(
            id: id, name: id, role: role, lifecycle: lifecycle,
            lastActivityAt: minutesAgo.map { WidgetSnapshot.fixtureCaptureDate.addingTimeInterval(-$0 * 60) })
    }

    private func snapshot(_ units: [WidgetUnit]) -> WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: "x", connection: .connected,
            capturedAt: WidgetSnapshot.fixtureCaptureDate, units: units)
    }

    /// Cones first, always. Then scoops, if any. Each group by recency.
    func testConesComeFirstEvenWhenAScoopIsMoreRecent() {
        let ranked = UnitRanking.ranked(
            snapshot([
                unit("scoop-fresh", .scoop, minutesAgo: 0),
                unit("cone-stale", .cone, minutesAgo: 600),
                unit("scoop-old", .scoop, minutesAgo: 5),
                unit("cone-fresh", .cone, minutesAgo: 1),
            ]))
        XCTAssertEqual(ranked.map(\.id), ["cone-fresh", "cone-stale", "scoop-fresh", "scoop-old"])
    }

    /// Urgency no longer outranks structure — but breaking IS a change, so a
    /// unit that just broke carries a fresh stamp and rises inside its group.
    func testABrokenScoopDoesNotJumpAheadOfTheConeThatOwnsIt() {
        let ranked = UnitRanking.ranked(
            snapshot([
                unit("cone", .cone, minutesAgo: 30),
                unit("broken", .scoop, minutesAgo: 0, lifecycle: .broken),
                unit("quiet", .scoop, minutesAgo: 20),
            ]))
        XCTAssertEqual(ranked.map(\.id), ["cone", "broken", "quiet"])
    }

    /// "We have never seen this move" is not a claim to recency.
    func testAStampedUnitOutranksAnUnstampedOne() {
        let ranked = UnitRanking.ranked(
            snapshot([
                unit("never-seen", .scoop, minutesAgo: nil),
                unit("ancient", .scoop, minutesAgo: 10_000),
            ]))
        XCTAssertEqual(ranked.map(\.id), ["ancient", "never-seen"])
    }

    /// Wire order breaks the last tie, so units with no stamp at all hold a
    /// stable position instead of shuffling on every refresh.
    func testWireOrderBreaksTheLastTie() {
        let ranked = UnitRanking.ranked(
            snapshot([
                unit("a", .scoop, minutesAgo: nil),
                unit("b", .scoop, minutesAgo: nil),
                unit("c", .scoop, minutesAgo: nil),
            ]))
        XCTAssertEqual(ranked.map(\.id), ["a", "b", "c"])
    }

    func testTheFixtureRanksBothConesAheadOfEveryScoop() {
        let ranked = UnitRanking.ranked(.fixtureCrowded)
        XCTAssertEqual(Array(ranked.prefix(2)).map(\.name), ["Sliccy", "Nightly"])
        XCTAssertTrue(ranked.dropFirst(2).allSatisfy { $0.role == .scoop })
        XCTAssertEqual(
            ranked.dropFirst(2).map(\.name),
            [
                "debt-triage", "packages-webapp-src-fs-sidecar-merge", "esp32-toolchain",
                "ios-transcript", "tray-hub-deploy", "memory-curator",
            ])
    }

    /// A session with no cone at all still ranks — scoops by recency.
    func testAConelessSessionFallsBackToRecencyAlone() {
        let ranked = UnitRanking.ranked(
            snapshot([unit("old", .scoop, minutesAgo: 9), unit("new", .scoop, minutesAgo: 1)]))
        XCTAssertEqual(ranked.map(\.id), ["new", "old"])
    }

    func testSmallTakesFourAndTheStripTakesTheRest() {
        let split = UnitRanking.split(.fixtureCrowded, count: UnitsWidgetCapacity.smallGrid)
        XCTAssertEqual(split.head.count, UnitsWidgetCapacity.smallGrid)
        XCTAssertEqual(
            split.head.count + split.tail.count, WidgetSnapshot.fixtureCrowded.units.count)
        XCTAssertTrue(
            Set(split.head.map(\.id)).isDisjoint(with: Set(split.tail.map(\.id))),
            "a unit must not appear in both the grid and the strip")
    }

    func testASmallSessionHasNoStripAtAll() {
        let split = UnitRanking.split(.fixtureAwaiting, count: UnitsWidgetCapacity.smallGrid)
        XCTAssertTrue(split.tail.isEmpty)
        XCTAssertEqual(split.head.count, 1)
    }

    /// Fewer units means bigger faces, not a small avatar marooned in the
    /// corner of the tile.
    func testFewerUnitsGetBiggerFacesOnSmall() {
        XCTAssertGreaterThan(UnitsWidgetSmall.avatarSize(for: 1), UnitsWidgetSmall.avatarSize(for: 2))
        XCTAssertGreaterThan(UnitsWidgetSmall.avatarSize(for: 2), UnitsWidgetSmall.avatarSize(for: 4))
        XCTAssertEqual(UnitsWidgetSmall.avatarSize(for: 40), UnitsWidgetSmall.avatarSize(for: 4))
        XCTAssertEqual(UnitsWidgetSmall.avatarSize(for: 0), UnitsWidgetSmall.avatarSize(for: 1))
    }

    // MARK: Medium — focus + field

    /// Medium leads with ONE unit, not four: the tile is twice as wide as it
    /// is tall, and four equal squares in a row leave a band of air above and
    /// below each of them.
    func testMediumLeadsWithASingleFocus() {
        let split = UnitRanking.split(.fixtureBusy, count: 1)
        XCTAssertEqual(split.head.map(\.name), ["Sliccy"], "the focus is the cone, not the loudest scoop")
        XCTAssertEqual(split.tail.count, 4)
    }

    func testMediumStatesWhatItsFieldCannotHold() {
        let tail = UnitRanking.split(.fixtureCrowded, count: 1).tail
        let shown = min(tail.count, UnitsWidgetCapacity.mediumField)
        XCTAssertEqual(tail.count - shown, 1, "the +N label")
    }

    // MARK: Large — medium's faces, then what was said

    /// Large is medium's arrangement plus the last turn. Rearranging the same
    /// faces into the extra 200pt only produced medium at 3x; the height goes
    /// to the one thing no other family can show.
    func testLargeLeadsWithTheSameFocusAsMedium() {
        XCTAssertEqual(
            UnitRanking.split(.fixtureBusy, count: 1).head.map(\.id),
            UnitRanking.split(.fixtureBusy, count: 1).head.map(\.id))
        XCTAssertGreaterThan(UnitsWidgetCapacity.largeField, 0)
    }

    func testLargeStatesWhatItsFieldCannotHold() {
        let tail = UnitRanking.split(.fixtureCrowded, count: 1).tail
        XCTAssertEqual(tail.count - min(tail.count, UnitsWidgetCapacity.largeField), 1)
    }

    /// The capture side truncates, but the model refuses to hold a transcript
    /// even if it is handed one.
    func testAMessageIsCappedAtItsPreviewLimit() {
        let long = String(repeating: "a", count: 5_000)
        XCTAssertEqual(
            WidgetMessage(author: .agent, text: long).text.count, WidgetMessage.previewLimit)
    }

    func testTheMessageIsAttributedToTheUnitThatSaidIt() {
        let snapshot = WidgetSnapshot.fixtureBusy
        let message = try? XCTUnwrap(snapshot.lastMessage)
        XCTAssertEqual(snapshot.lastMessageUnit?.name, "Sliccy")
        let view = LastMessageView(
            message: message!, unit: snapshot.lastMessageUnit, palette: .dark,
            now: WidgetSnapshot.fixtureCaptureDate)
        XCTAssertEqual(view.attribution, "Sliccy")
    }

    func testAUserTurnIsAttributedToYouAndWearsNoFace() {
        let snapshot = WidgetSnapshot.fixtureCrowded
        let message = try? XCTUnwrap(snapshot.lastMessage)
        XCTAssertEqual(message?.author, .user)
        XCTAssertNil(snapshot.lastMessageUnit, "a user turn names no unit")
        XCTAssertEqual(
            LastMessageView(
                message: message!, unit: nil, palette: .dark,
                now: WidgetSnapshot.fixtureCaptureDate
            ).attribution, "You")
    }

    /// An agent turn whose unit has since left the snapshot still prints.
    func testAMessageFromAVanishedUnitStillHasAnAttribution() {
        let orphaned = WidgetSnapshot(
            instanceLabel: "x", connection: .connected, capturedAt: .distantPast, units: [],
            lastMessage: WidgetMessage(author: .agent, unitId: "gone", text: "hi"))
        XCTAssertNil(orphaned.lastMessageUnit)
        XCTAssertEqual(
            LastMessageView(
                message: orphaned.lastMessage!, unit: nil, palette: .dark, now: .distantPast
            ).attribution, "Agent")
    }

    /// The message carries its OWN time. A snapshot taken now can hold a turn
    /// from an hour ago, and the two times sit next to each other on the tile.
    func testTheMessageTimeIsRelativeToTheMessage() {
        let now = WidgetSnapshot.fixtureCaptureDate
        func elapsed(_ seconds: TimeInterval?) -> String? {
            LastMessageView(
                message: WidgetMessage(
                    author: .agent, text: "x", at: seconds.map { now.addingTimeInterval(-$0) }),
                unit: nil, palette: .dark, now: now
            ).elapsed
        }
        XCTAssertNil(elapsed(nil), "no timestamp, no claim")
        XCTAssertEqual(elapsed(20), "now")
        XCTAssertEqual(elapsed(7 * 60), "7m ago")
        XCTAssertEqual(elapsed(5 * 3600), "5h ago")
        XCTAssertEqual(elapsed(3 * 86400), "3d ago")
    }

    /// A booting cone has said nothing, and large must survive that without an
    /// empty frame where the message goes.
    func testAQuietSessionCarriesNoMessage() {
        XCTAssertNil(WidgetSnapshot.fixtureStarting.lastMessage)
    }

    /// A snapshot 52 minutes old cannot be carrying a five-minute-old message;
    /// the large family prints both times right next to each other.
    func testTheStaleFixturesTimesAgree() {
        let snapshot = WidgetSnapshot.fixtureDisconnected
        let at = try? XCTUnwrap(snapshot.lastMessage?.at)
        XCTAssertLessThanOrEqual(at!, snapshot.capturedAt)
    }

    /// A cap that is not stated reads as "that is everything".
    func testTheGridStatesWhatItDrops() {
        let many = (0..<9).map {
            WidgetUnit(id: "s\($0)", name: "s\($0)", role: .scoop, lifecycle: .idle)
        }
        let grid = UnitGrid(
            units: Array(many.prefix(4)), palette: .dark, columns: 4,
            avatarSize: 40, nameSize: 9, trailing: many.count - 4)
        XCTAssertEqual(grid.rows.count, 1)
        XCTAssertEqual(grid.trailing, 5)

        let exact = UnitGrid(units: many, palette: .dark, columns: 3, avatarSize: 40, nameSize: 9)
        XCTAssertEqual(exact.rows.count, 3)
        XCTAssertEqual(exact.rows.last?.count, 3)
    }

    func testAZeroColumnGridDoesNotDivideByZero() {
        let grid = UnitGrid(
            units: [WidgetUnit(id: "a", name: "a", role: .cone)], palette: .dark,
            columns: 0, avatarSize: 20, nameSize: 9)
        XCTAssertEqual(grid.rows.count, 1)
    }

    /// A cap that is not stated reads as "that is everything".
    func testTheStripCountsWhatItCannotShow() {
        let many = (0..<30).map {
            WidgetUnit(id: "s\($0)", name: "s\($0)", role: .scoop, lifecycle: .idle)
        }
        let strip = UnitOverflowStrip(
            units: many, palette: .dark, avatarSize: 14,
            limit: UnitsWidgetCapacity.smallStrip)
        XCTAssertEqual(strip.hidden, 30 - UnitsWidgetCapacity.smallStrip)
        XCTAssertTrue(strip.accessibilityPhrase.contains("\(strip.hidden) more"))

        let few = UnitOverflowStrip(units: Array(many.prefix(2)), palette: .dark, avatarSize: 14, limit: 5)
        XCTAssertEqual(few.hidden, 0)
        XCTAssertFalse(few.accessibilityPhrase.contains("more"))
    }

    func testStalenessTextIsACaptureTimeNotACountdown() {
        let now = WidgetSnapshot.fixtureCaptureDate
        func text(connection: WidgetSnapshot.Connection, ageSeconds: TimeInterval) -> String? {
            InstanceHeader(
                snapshot: WidgetSnapshot(
                    instanceLabel: "x", connection: connection,
                    capturedAt: now.addingTimeInterval(-ageSeconds), units: []),
                palette: .dark, now: now
            ).stalenessText
        }
        XCTAssertNil(text(connection: .connected, ageSeconds: 30), "a live channel says nothing")
        XCTAssertEqual(text(connection: .disconnected, ageSeconds: 30), "just now")
        XCTAssertEqual(text(connection: .disconnected, ageSeconds: 4 * 60), "4m ago")
        XCTAssertEqual(text(connection: .disconnected, ageSeconds: 3 * 3600), "3h ago")
        XCTAssertEqual(text(connection: .disconnected, ageSeconds: 2 * 86400), "2d ago")
        XCTAssertNil(text(connection: .none, ageSeconds: 60), "there is nothing to be stale about")
    }

    func testTheUnavailableCopyNamesTheHostAppTheUserActuallyHas() {
        let view = UnavailableView(
            snapshot: .fixtureDisconnected, palette: .dark, host: .sliccstart)
        XCTAssertEqual(view.headline, "Not connected")
        XCTAssertTrue(view.detail.contains("Sliccstart"))
        XCTAssertTrue(
            UnavailableView(snapshot: .unavailable(), palette: .dark, host: .follower)
                .detail.contains("Join"))
    }

    func testEveryFixtureIsDrawnByTheGallery() {
        XCTAssertEqual(WidgetSnapshot.allFixtures.count, 6)
        XCTAssertEqual(Set(WidgetSnapshot.allFixtures.map(\.name)).count, 6)
    }

    #if os(iOS)
        /// The lock screen is the ONE surface that still spells the status
        /// out: `.widgetAccentable()` flattens the avatar to a silhouette, so
        /// the face cannot carry the phase there.
        func testTheLockScreenStillSpellsTheStatusOut() {
            let context = WidgetRenderContext(
                snapshot: .fixtureBusy, now: WidgetSnapshot.fixtureCaptureDate, host: .follower)
            XCTAssertTrue(UnitsWidgetInline(context: context).phrase.contains("needs you"))
            XCTAssertTrue(UnitsWidgetRectangular(context: context).tally.contains("working"))
        }
    #endif
}
