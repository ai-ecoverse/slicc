import SliccWidgetKit
import XCTest

@testable import SliccFollower







final class SliccConversationIndexerTests: XCTestCase {

    
    
    private actor FakeIndex: SpotlightConversationIndex {
        enum Operation: Equatable {
            case delete
            case index([String])
        }

        private(set) var operations: [Operation] = []
        
        
        
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

    

    func testASingleDonationDeletesThenIndexes() async {
        let fake = FakeIndex()
        let indexer = SliccConversationIndexer(index: fake)
        await indexer.donate([unit("a")]).value

        let ops = await fake.log()
        XCTAssertEqual(ops, [.delete, .index(["a"])])
        let settled = await fake.settled()
        XCTAssertEqual(settled, ["a"])
    }

    
    
    func testAnEmptyDonationDeletesAndDoesNotIndex() async {
        let fake = FakeIndex()
        let indexer = SliccConversationIndexer(index: fake)
        await indexer.donate([]).value

        let ops = await fake.log()
        XCTAssertEqual(ops, [.delete])
        let settled = await fake.settled()
        XCTAssertEqual(settled, [])
    }

    

    
    
    
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

        
        
        let ops = await fake.log()
        let indexed = ops.compactMap { op -> [String]? in
            if case .index(let ids) = op { return ids }
            return nil
        }
        XCTAssertFalse(indexed.contains(["mid"]), "a superseded donation does no indexing")
    }

    
    
    func testSequentialDonationsEachApply() async {
        let fake = FakeIndex()
        let indexer = SliccConversationIndexer(index: fake)

        await indexer.donate([unit("first")]).value
        await indexer.donate([unit("second")]).value

        let ops = await fake.log()
        XCTAssertEqual(ops, [.delete, .index(["first"]), .delete, .index(["second"])])
    }

    
    
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
