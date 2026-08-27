import Foundation
import SwiftUI
import XCTest

@testable import SliccWidgetKit

/// The layout decisions worth a test are the ones a screenshot does not catch:
/// which units get a cell, in what order, and what gets DROPPED when the tile
/// runs out of room. A unit nobody can see is the widget lying about the
/// session.
final class UnitsWidgetLayoutTests: XCTestCase {
    func testAttentionRanksAheadOfEverythingElse() {
        let ranked = UnitRanking.ranked(.fixtureBusy).map(\.name)
        XCTAssertEqual(ranked.first, "flaky-test-triage", "broken wants a human first")
        XCTAssertEqual(
            ranked,
            [
                "flaky-test-triage",  // broken
                "Sliccy",  // working, and a cone
                "boy-scout",  // working
                "release-notes-drafter",  // working
                "coverage-ratchet",  // your turn
            ])
    }

    /// A cone outranks a scoop in the same band: it is the unit you can
    /// actually talk to.
    func testConesOutrankScoopsWithinABand() {
        let snapshot = WidgetSnapshot(
            instanceLabel: "x", connection: .connected, capturedAt: .distantPast,
            units: [
                WidgetUnit(id: "s", name: "scoop", role: .scoop, lifecycle: .working),
                WidgetUnit(id: "c", name: "cone", role: .cone, lifecycle: .working),
            ])
        XCTAssertEqual(UnitRanking.ranked(snapshot).map(\.id), ["c", "s"])
    }

    /// Wire order breaks the last tie, so the grid does not reshuffle on every
    /// refresh — a face that moves cell every 15 minutes is unreadable.
    func testRankingIsStableWithinABand() {
        let ranked = UnitRanking.ranked(.fixtureCrowded).map(\.id)
        XCTAssertLessThan(ranked.firstIndex(of: "s1")!, ranked.firstIndex(of: "s3")!)
        XCTAssertLessThan(ranked.firstIndex(of: "s3")!, ranked.firstIndex(of: "s6")!)
    }

    func testAwaitingOutranksIdleButNotBusy() {
        let snapshot = WidgetSnapshot(
            instanceLabel: "x", connection: .connected, capturedAt: .distantPast,
            units: [
                WidgetUnit(id: "idle", name: "i", role: .scoop, lifecycle: .idle),
                WidgetUnit(
                    id: "await", name: "a", role: .scoop, lifecycle: .idle, activity: .awaiting),
                WidgetUnit(id: "busy", name: "b", role: .scoop, lifecycle: .working),
                WidgetUnit(id: "boot", name: "s", role: .scoop, lifecycle: .initializing),
            ])
        XCTAssertEqual(UnitRanking.ranked(snapshot).map(\.id), ["busy", "boot", "await", "idle"])
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
        XCTAssertEqual(split.head.map(\.name), ["flaky-test-triage"])
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
