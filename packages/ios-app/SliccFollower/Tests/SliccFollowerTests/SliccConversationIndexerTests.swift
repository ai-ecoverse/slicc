import SliccWidgetKit
import XCTest

@testable import SliccFollower

/// Spotlight replacement donations (PR #2582 review, P2).
///
/// A donation is delete-then-index, and `publishWidgetSnapshot()` fires on
/// `scoops.list`, on connection flips and on `turn_end` — back to back. The
/// property under test is that the LAST donation queued decides the final
/// index contents, whatever the timing of the ones before it.
final class SliccConversationIndexerTests: XCTestCase {

    /// Records the operations in the order they actually execute, and can
    /// stall on demand so a second donation is guaranteed to arrive mid-flight.
    private actor FakeIndex: SpotlightConversationIndex {
        enum Operation: Equatable {
            case delete
            case index([String])
        }

        private(set) var operations: [Operation] = []
        /// What Spotlight would actually hold right now — the property that
        /// matters. An intermediate index that a later delete removes is not a
        /// bug; a stale entry SURVIVING the last donation is.
        private(set) var contents: [String] = []
        private var deleteDelay: Duration = .zero

        func stallDeletes(by delay: Duration) { deleteDelay = delay }

        func log() -> [Operation] { operations }

        func settled() -> [String] { contents }

        func deleteConversations() async throws {
            if deleteDelay > .zero { try? await Task.sleep(for: deleteDelay) }
            operations.append(.delete)
            contents = []
        }

        func indexConversations(_ entities: [SliccConversationEntity]) async throws {
            operations.append(.index(entities.map(\.id)))
            contents = entities.map(\.id)
        }
    }

    private func unit(_ id: String) -> WidgetUnit {
        WidgetUnit(id: id, name: id, role: .cone)
    }

    // MARK: - Single donation

    func testASingleDonationDeletesThenIndexes() async {
        let fake = FakeIndex()
        let indexer = SliccConversationIndexer(index: fake)
        await indexer.donate([unit("a")]).value

        let ops = await fake.log()
        XCTAssertEqual(ops, [.delete, .index(["a"])])
        let settled = await fake.settled()
        XCTAssertEqual(settled, ["a"])
    }

    /// An empty set deletes and stops — there is nothing to index, and the
    /// delete is the whole point (it is how a detached session leaves no hit).
    func testAnEmptyDonationDeletesAndDoesNotIndex() async {
        let fake = FakeIndex()
        let indexer = SliccConversationIndexer(index: fake)
        await indexer.donate([]).value

        let ops = await fake.log()
        XCTAssertEqual(ops, [.delete])
        let settled = await fake.settled()
        XCTAssertEqual(settled, [])
    }

    // MARK: - Overlap

    /// The reported race: a publish in flight when the user detaches. The
    /// detach donates an empty set, and the older publish must not put the
    /// conversations back afterwards.
    func testDetachRacingAPublishLeavesTheIndexEmpty() async {
        let fake = FakeIndex()
        await fake.stallDeletes(by: .milliseconds(50))
        let indexer = SliccConversationIndexer(index: fake)

        let publish = await indexer.donate([unit("a"), unit("b")])
        let detach = await indexer.donate([])
        await publish.value
        await detach.value

        let settled = await fake.settled()
        XCTAssertEqual(settled, [], "a detach must win over an in-flight publish")
    }

    /// The general property: whoever is queued last wins, and the superseded
    /// donation does no work at all rather than work the next one undoes.
    func testTheLastQueuedDonationDecidesTheIndex() async {
        let fake = FakeIndex()
        await fake.stallDeletes(by: .milliseconds(20))
        let indexer = SliccConversationIndexer(index: fake)

        let first = await indexer.donate([unit("old")])
        let second = await indexer.donate([unit("mid")])
        let third = await indexer.donate([unit("new")])
        await first.value
        await second.value
        await third.value

        let settled = await fake.settled()
        XCTAssertEqual(settled, ["new"], "the last donation queued decides the index")

        // The generation gate should also spare the middle donation the work,
        // since its result would only be overwritten.
        let ops = await fake.log()
        let indexed = ops.compactMap { op -> [String]? in
            if case .index(let ids) = op { return ids }
            return nil
        }
        XCTAssertFalse(indexed.contains(["mid"]), "a superseded donation does no indexing")
    }

    /// Sequential donations each apply in full — the generation gate must skip
    /// only donations that are genuinely superseded, not every second one.
    func testSequentialDonationsEachApply() async {
        let fake = FakeIndex()
        let indexer = SliccConversationIndexer(index: fake)

        await indexer.donate([unit("first")]).value
        await indexer.donate([unit("second")]).value

        let ops = await fake.log()
        XCTAssertEqual(ops, [.delete, .index(["first"]), .delete, .index(["second"])])
    }

    /// Donations never overlap: no second delete starts before the first
    /// donation has finished its index.
    func testDonationsDoNotInterleave() async {
        let fake = FakeIndex()
        await fake.stallDeletes(by: .milliseconds(10))
        let indexer = SliccConversationIndexer(index: fake)

        let a = await indexer.donate([unit("a")])
        await a.value
        let b = await indexer.donate([unit("b")])
        await b.value

        let ops = await fake.log()
        XCTAssertEqual(ops, [.delete, .index(["a"]), .delete, .index(["b"])])
    }
}
